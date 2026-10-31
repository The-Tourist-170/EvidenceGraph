import {
  getEmbeddingConfig,
  getIntegrationConfig,
  getLlmConfig,
  getMcpSearchConfig,
  getObservabilityConfig,
  getRerankConfig,
} from "@evidencegraph/config";
import { createEmbeddingClient } from "./embeddings.js";
import { IntegrationError } from "./errors.js";
import {
  buildEvidencePrompt,
  createStructuredGenerator,
  researchSynthesisSchema,
  researchSystemPrompt,
} from "./llm.js";
import { createMetrics, createTracer } from "./observability.js";
import { createReranker } from "./rerank.js";
import { createWebSearchTool } from "./web-search.js";

export function createResearchIntegrations({
  env = process.env,
  llm,
  llmConfig,
  mcpConfig,
  embeddingConfig,
  rerankConfig,
  observabilityConfig,
  search,
  embeddings,
  reranker,
  metrics,
  tracer,
} = {}) {
  const integration = getIntegrationConfig(env);
  if (!integration.enabled) return null;

  const resolvedMetrics = metrics ?? createMetrics();
  const resolvedTracer =
    tracer ??
    createTracer({
      config: observabilityConfig ?? getObservabilityConfig(env),
    });
  const generator =
    llm ??
    createStructuredGenerator({
      config: llmConfig ?? getLlmConfig(env),
      metrics: resolvedMetrics,
      tracer: resolvedTracer,
    });
  const webSearch =
    search ??
    createWebSearchTool({
      config: mcpConfig ?? getMcpSearchConfig(env),
      metrics: resolvedMetrics,
    });
  let embeddingClient = embeddings ?? null;
  if (!embeddingClient) {
    const config = embeddingConfig ?? getEmbeddingConfig(env);
    if (config) {
      embeddingClient = createEmbeddingClient({
        config,
        metrics: resolvedMetrics,
      });
    }
  }
  const rerankClient =
    reranker ??
    createReranker({
      config: rerankConfig ?? getRerankConfig(env),
      metrics: resolvedMetrics,
    });

  return {
    available: {
      llm: true,
      webSearch: webSearch.available,
      embeddings: Boolean(embeddingClient),
      reranking: rerankClient.available,
    },
    async close() {
      await webSearch.close();
    },
    embeddings: embeddingClient,
    llm: generator,
    metrics: resolvedMetrics,
    reranker: rerankClient,
    search: webSearch,
    tracer: resolvedTracer,
  };
}

export async function runResearch({
  question,
  maxSources = 5,
  signal,
  onProgress,
  integrations,
}) {
  if (!integrations) {
    throw new IntegrationError(
      "AI_INTEGRATIONS_UNAVAILABLE",
      "Research integrations are not configured.",
    );
  }
  const normalizedQuestion = String(question ?? "").trim();
  if (normalizedQuestion.length === 0) {
    throw new IntegrationError(
      "RESEARCH_QUESTION_INVALID",
      "A non-empty research question is required.",
    );
  }

  await onProgress?.({
    percent: 10,
    stage: "planning",
    message: "Planning the research steps.",
  });
  const sources = await integrations.search.search({
    query: normalizedQuestion,
    limit: maxSources,
    signal,
  });
  await onProgress?.({
    percent: 55,
    stage: "evidence-review",
    message: `Reviewed ${sources.length} external sources.`,
  });

  const allowedSources = new Set(sources.map((source) => source.sourceId));
  const synthesis = await integrations.llm.generate({
    schema: researchSynthesisSchema,
    system: researchSystemPrompt,
    user: [
      `Research question:\n${normalizedQuestion}`,
      `Evidence:\n${buildEvidencePrompt(sources)}`,
    ].join("\n\n"),
    signal,
    operation: "research_synthesis",
    name: "research_synthesis",
  });
  const sourceIds = [
    ...new Set(synthesis.sourceIds.filter((id) => allowedSources.has(id))),
  ];
  if (sourceIds.length === 0) {
    throw new IntegrationError(
      "RESEARCH_CITATIONS_MISSING",
      "The synthesized report did not cite any retrieved source.",
    );
  }
  await onProgress?.({
    percent: 90,
    stage: "synthesis",
    message: "Preparing a cited summary.",
  });

  return {
    summary: synthesis.summary,
    claims: synthesis.claims,
    sourceIds,
    synthetic: false,
  };
}
