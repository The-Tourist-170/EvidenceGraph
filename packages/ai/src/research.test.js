import { describe, expect, test } from "bun:test";
import { IntegrationError } from "./errors.js";
import { createResearchIntegrations, runResearch } from "./research.js";

const source = {
  sourceId: "source-1",
  url: "https://example.test/source",
  title: "Fixture source",
  snippet: "A relevant fixture snippet.",
  trust: "untrusted",
  provenance: {
    provider: "mcp",
    tool: "web_search",
    retrievedAt: "2026-10-31T00:00:00.000Z",
  },
};

function createIntegrations(overrides = {}) {
  return {
    available: {
      llm: true,
      webSearch: true,
      embeddings: true,
      reranking: false,
    },
    embeddings: {
      dimensions: 3,
      embedDocuments: async () => [],
    },
    llm: {
      async generate() {
        return {
          summary: "A supported summary.",
          claims: ["A supported claim."],
          sourceIds: ["source-1"],
        };
      },
    },
    metrics: {},
    reranker: {
      available: false,
      rerank: async () => ({ fallback: true, results: [] }),
    },
    search: {
      async search() {
        return [source];
      },
    },
    tracer: { enabled: false, wrap: (_name, operation) => operation },
    ...overrides,
  };
}

describe("research integrations", () => {
  test("stays disabled without an explicit opt-in or production mode", () => {
    expect(
      createResearchIntegrations({ env: { NODE_ENV: "test" } }),
    ).toBeNull();
    expect(
      createResearchIntegrations({
        env: {
          NODE_ENV: "test",
          AI_INTEGRATIONS_ENABLED: "true",
          LLM_BASE_URL: "https://llm.example.test/v1",
          LLM_MODEL_NAME: "model-a",
          LLM_API_KEY: "key",
        },
        llm: { generate: async () => ({}) },
        search: {
          available: true,
          search: async () => [],
          close: async () => {},
        },
        embeddings: { dimensions: 3 },
        reranker: { available: false },
        tracer: { enabled: false, wrap: (_name, operation) => operation },
      }),
    ).toMatchObject({
      available: { llm: true, webSearch: true },
    });
  });
});

describe("research execution", () => {
  test("retrieves sources, synthesizes, and filters invented citations", async () => {
    const progress = [];
    const result = await runResearch({
      question: "How do urban trees reduce heat?",
      maxSources: 5,
      integrations: createIntegrations({
        llm: {
          async generate() {
            return {
              summary: "Trees cool streets.",
              claims: ["Shade reduces surface temperature."],
              sourceIds: ["source-1", "invented-source"],
            };
          },
        },
      }),
      onProgress: (value) => progress.push(value),
    });
    expect(result).toEqual({
      summary: "Trees cool streets.",
      claims: ["Shade reduces surface temperature."],
      sourceIds: ["source-1"],
      synthetic: false,
    });
    expect(progress.map(({ stage }) => stage)).toEqual([
      "planning",
      "evidence-review",
      "synthesis",
    ]);
  });

  test("fails when the report cites no retrieved source", async () => {
    await expect(
      runResearch({
        question: "Unsupported question?",
        integrations: createIntegrations({
          llm: {
            async generate() {
              return { summary: "Unsourced.", claims: [], sourceIds: [] };
            },
          },
        }),
      }),
    ).rejects.toMatchObject({ code: "RESEARCH_CITATIONS_MISSING" });
  });

  test("propagates the classified web-search unavailability failure", async () => {
    await expect(
      runResearch({
        question: "No search configured?",
        integrations: createIntegrations({
          search: {
            async search() {
              throw new IntegrationError(
                "WEB_SEARCH_UNAVAILABLE",
                "No MCP web-search server is configured.",
              );
            },
          },
        }),
      }),
    ).rejects.toMatchObject({ code: "WEB_SEARCH_UNAVAILABLE" });
  });

  test("rejects an empty question and missing integrations", async () => {
    await expect(
      runResearch({ question: "  ", integrations: createIntegrations() }),
    ).rejects.toMatchObject({ code: "RESEARCH_QUESTION_INVALID" });
    await expect(
      runResearch({ question: "valid question", integrations: null }),
    ).rejects.toMatchObject({ code: "AI_INTEGRATIONS_UNAVAILABLE" });
  });
});
