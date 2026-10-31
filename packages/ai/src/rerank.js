import { z } from "zod";
import { getRerankConfig } from "@evidencegraph/config";
import { classifyProviderError, IntegrationError } from "./errors.js";

const rerankInputSchema = z
  .object({
    query: z.string().min(1).max(2_000),
    documents: z
      .array(
        z
          .object({
            id: z.string().min(1).max(128),
            text: z.string().min(1).max(20_000),
          })
          .strict(),
      )
      .min(1),
    limit: z.number().int().min(1).max(100).default(10),
  })
  .strict();

function tokenize(value) {
  return value
    .toLowerCase()
    .normalize("NFKC")
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1);
}

export function lexicalScore(query, text) {
  const queryTokens = new Set(tokenize(query));
  const textTokens = new Set(tokenize(text));
  if (queryTokens.size === 0 || textTokens.size === 0) return 0;
  let overlap = 0;
  for (const token of queryTokens) {
    if (textTokens.has(token)) overlap += 1;
  }
  return overlap / Math.sqrt(queryTokens.size * textTokens.size);
}

export function lexicalRerank({ query, documents, limit }) {
  return documents
    .map((document, index) => ({
      id: document.id,
      index,
      score: lexicalScore(query, document.text),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map(({ id, score }) => ({ id, score }));
}

export function createReranker({
  config = getRerankConfig(),
  fetchImpl = globalThis.fetch,
  metrics,
} = {}) {
  async function rerank(args = {}) {
    const parsed = rerankInputSchema.parse(args);
    const candidates = config
      ? parsed.documents.slice(0, config.maxCandidates)
      : parsed.documents;
    if (!config) {
      return {
        fallback: true,
        results: lexicalRerank({ ...parsed, documents: candidates }),
      };
    }
    const started = performance.now();
    try {
      const signal = AbortSignal.timeout(config.timeoutMs);
      const response = await fetchImpl(config.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(config.apiKey
            ? { authorization: `Bearer ${config.apiKey}` }
            : {}),
        },
        body: JSON.stringify({
          model: config.modelName,
          query: parsed.query,
          documents: candidates.map((document) => document.text),
          top_n: parsed.limit,
        }),
        signal,
      });
      if (!response.ok) {
        const error = new Error("Rerank provider request failed.");
        error.status = response.status;
        throw classifyProviderError(error, {
          operation: "Rerank provider",
        });
      }
      const payload = await response.json();
      const rawResults = Array.isArray(payload?.results)
        ? payload.results
        : null;
      if (!rawResults) {
        throw new IntegrationError(
          "RERANK_INVALID_RESULT",
          "The rerank provider returned an unsupported result shape.",
        );
      }
      const scored = rawResults
        .map((item) => {
          const index = item?.index;
          const score = item?.relevance_score ?? item?.score;
          if (
            !Number.isInteger(index) ||
            index < 0 ||
            index >= candidates.length ||
            !Number.isFinite(score)
          ) {
            return null;
          }
          return { id: candidates[index].id, score };
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score)
        .slice(0, parsed.limit);
      if (scored.length === 0) {
        throw new IntegrationError(
          "RERANK_INVALID_RESULT",
          "The rerank provider returned no usable scores.",
        );
      }
      metrics?.recordCall({
        operation: "rerank",
        durationMs: performance.now() - started,
        ok: true,
      });
      return { fallback: false, results: scored };
    } catch (error) {
      const classified =
        error instanceof IntegrationError
          ? error
          : classifyProviderError(error, { operation: "Rerank provider" });
      metrics?.recordCall({
        operation: "rerank",
        durationMs: performance.now() - started,
        ok: false,
        code: classified.code,
      });
      return {
        fallback: true,
        errorCode: classified.code,
        results: lexicalRerank({ ...parsed, documents: candidates }),
      };
    }
  }

  return { available: Boolean(config), rerank };
}
