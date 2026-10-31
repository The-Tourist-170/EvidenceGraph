import { z } from "zod";
import { getEmbeddingConfig } from "@evidencegraph/config";
import { classifyProviderError, IntegrationError } from "./errors.js";
import { withRetry } from "./observability.js";

const inputSchema = z.array(z.string().min(1).max(20_000));

export function createEmbeddingClient({
  config = getEmbeddingConfig(),
  fetchImpl = globalThis.fetch,
  metrics,
  retries = 2,
  retryDelayMs = 250,
} = {}) {
  if (!config) {
    throw new IntegrationError(
      "EMBEDDING_UNAVAILABLE",
      "No embedding provider is configured.",
    );
  }
  const endpoint = `${config.baseUrl.replace(/\/+$/, "")}/embeddings`;

  async function embedBatch(texts, { signal } = {}) {
    const input = inputSchema.max(config.batchSize).parse(texts);
    if (input.length === 0) return [];
    const started = performance.now();
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({ model: config.modelName, input }),
        signal,
      });
      if (!response.ok) {
        const error = new Error("Embedding provider request failed.");
        error.status = response.status;
        throw classifyProviderError(error, {
          operation: "Embedding provider",
        });
      }
      const payload = await response.json();
      const vectors = payload?.data?.map((item) => item?.embedding);
      if (!Array.isArray(vectors) || vectors.length !== input.length) {
        throw new IntegrationError(
          "EMBEDDING_INVALID_RESULT",
          "The embedding provider returned an unexpected result count.",
        );
      }
      for (const vector of vectors) {
        if (!Array.isArray(vector) || vector.length !== config.dimensions) {
          throw new IntegrationError(
            "EMBEDDING_DIMENSION_MISMATCH",
            `Expected ${config.dimensions} dimensions from the embedding provider.`,
          );
        }
        if (vector.some((value) => !Number.isFinite(value))) {
          throw new IntegrationError(
            "EMBEDDING_INVALID_RESULT",
            "The embedding provider returned a non-finite vector value.",
          );
        }
      }
      const tokens = Number(payload?.usage?.total_tokens ?? 0);
      metrics?.recordCall({
        operation: "embedding",
        durationMs: performance.now() - started,
        tokens: Number.isFinite(tokens) ? tokens : 0,
        ok: true,
      });
      return vectors;
    } catch (error) {
      if (error instanceof IntegrationError) {
        metrics?.recordCall({
          operation: "embedding",
          durationMs: performance.now() - started,
          ok: false,
          code: error.code,
        });
        throw error;
      }
      const classified = classifyProviderError(error, {
        operation: "Embedding provider",
      });
      metrics?.recordCall({
        operation: "embedding",
        durationMs: performance.now() - started,
        ok: false,
        code: classified.code,
      });
      throw classified;
    }
  }

  async function embedDocuments(texts, { signal } = {}) {
    inputSchema.parse(texts);
    const vectors = [];
    for (let index = 0; index < texts.length; index += config.batchSize) {
      const batch = texts.slice(index, index + config.batchSize);
      const batchVectors = await withRetry(
        () => embedBatch(batch, { signal }),
        {
          retries,
          baseDelayMs: retryDelayMs,
          signal,
          shouldRetry: (error) =>
            error instanceof IntegrationError ? error.retryable : false,
          onRetry: () => metrics?.recordRetry(),
        },
      );
      vectors.push(...batchVectors);
    }
    return vectors;
  }

  async function embedQuery(text, options) {
    const [vector] = await embedBatch([text], options);
    return vector;
  }

  return {
    dimensions: config.dimensions,
    embedBatch,
    embedDocuments,
    embedQuery,
    modelName: config.modelName,
  };
}
