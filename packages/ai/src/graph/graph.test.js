import { describe, expect, test } from "bun:test";
import {
  assembleContext,
  createResearchGraph,
  invokeResearchGraph,
  planNode,
} from "./index.js";

const taskId = "00000000-0000-4000-8000-000000000001";
const threadId = taskId;
const documentId = "00000000-0000-4000-8000-000000000003";
const chunkId = "00000000-0000-4000-8000-000000000002";
const owner = { userId: "user-a", workspaceId: "workspace-a" };
const question = "How do urban trees reduce summer heat?";
const baseConfig = {
  depth: "standard",
  maxSources: 5,
  maxIterations: 2,
  maxDurationSeconds: 60,
  requiresApproval: false,
};

function chunkPoint() {
  return {
    id: chunkId,
    rrfScore: 0.9,
    payload: {
      chunkId,
      documentId,
      content: "Urban trees reduce street temperatures through shade.",
      metadata: { filename: "trees.txt", chunkIndex: 0 },
    },
  };
}

function fakeLlm(overrides = {}) {
  return {
    async generate({ operation, schema }) {
      if (operation === "research_plan") {
        return schema.parse({
          subquestions: ["What role does shade play?"],
          queries: ["urban trees shade temperature"],
          sourceRequirements: "At least three sources.",
        });
      }
      if (operation === "evidence_verification") {
        return schema.parse({
          supported: [{ claim: "Trees provide shade.", sourceIds: [chunkId] }],
          unsupported: [],
          conflicts: [],
          confidence: 0.8,
        });
      }
      if (operation === "report_generation") {
        return schema.parse({
          title: "Urban trees and heat",
          summary: "Trees reduce street temperatures through shade.",
          sections: [
            { heading: "Findings", body: "Shade lowers surface heat." },
          ],
          claims: [
            {
              text: "Trees provide shade.",
              sourceIds: [chunkId, "invented-source"],
            },
          ],
          limitations: ["Evidence is limited."],
        });
      }
      return overrides[operation] ?? {};
    },
  };
}

function createDependencies({
  points = [chunkPoint()],
  searchAvailable = true,
  config = baseConfig,
  llm = fakeLlm(),
} = {}) {
  const saved = [];
  const searchCalls = [];
  let retrievalCalls = 0;
  return {
    saved,
    searchCalls,
    get retrievalCalls() {
      return retrievalCalls;
    },
    graph: createResearchGraph({
      llm,
      search: {
        available: searchAvailable,
        async search({ query }) {
          searchCalls.push(query);
          return [
            {
              sourceId: "external-1",
              url: "https://example.test/external",
              title: "External source",
              snippet: "External evidence.",
              trust: "untrusted",
              provenance: {
                provider: "mcp",
                tool: "web_search",
                retrievedAt: "2026-10-31T00:00:00.000Z",
              },
            },
          ];
        },
      },
      embeddings: {
        dimensions: 3,
        async embedQuery() {
          return [0.1, 0.2, 0.3];
        },
      },
      reranker: {
        async rerank({ documents }) {
          return {
            fallback: false,
            results: documents.map((document, index) => ({
              id: document.id,
              score: 1 - index * 0.1,
            })),
          };
        },
      },
      vectorRepository: {
        async searchHybrid() {
          retrievalCalls += 1;
          return points;
        },
      },
      graphRepository: {
        async getDocumentEntities() {
          return [
            {
              id: "00000000-0000-4000-8000-000000000004",
              name: "Urban Trees",
              kind: "concept",
            },
          ];
        },
        async getDocumentRelationships() {
          return [
            {
              from: "urban trees",
              to: "summer heat",
              type: "REDUCES",
              confidence: 0.8,
            },
          ];
        },
      },
      reportStore: {
        async saveReport(value) {
          saved.push(value);
          return {
            id: "00000000-0000-4000-8000-000000000099",
            currentRevision: 1,
          };
        },
      },
      config,
    }),
  };
}

function input(overrides = {}) {
  return {
    taskId,
    threadId,
    owner,
    question,
    config: baseConfig,
    ...overrides,
  };
}

describe("research graph", () => {
  test("runs planning, hybrid retrieval, verification, and report persistence", async () => {
    const progress = [];
    const dependencies = createDependencies();
    const outcome = await invokeResearchGraph({
      graph: dependencies.graph,
      input: input(),
      threadId,
      onProgress: (value) => progress.push(value),
    });

    expect(outcome.interrupted).toBe(false);
    expect(outcome.state.status).toBe("completed");
    expect(outcome.state.report.claims).toHaveLength(1);
    expect(outcome.state.report.claims[0].sourceIds).toEqual([chunkId]);
    expect(outcome.state.report.sourceIds).toEqual([chunkId]);
    expect(outcome.state.graphEvidence.entities[0].name).toBe("Urban Trees");
    expect(dependencies.saved).toHaveLength(1);
    expect(dependencies.saved[0]).toMatchObject({ taskId });
    expect(progress.map(({ stage }) => stage)).toContain("report");
    expect(progress.map(({ stage }) => stage)).toContain("verification");
  });

  test("ends in a classified failure when no evidence is available", async () => {
    const dependencies = createDependencies({
      points: [],
      searchAvailable: false,
    });
    const outcome = await invokeResearchGraph({
      graph: dependencies.graph,
      input: input(),
      threadId,
    });
    expect(outcome.interrupted).toBe(false);
    expect(outcome.state.status).toBe("failed");
    expect(outcome.state.error.code).toBe("RESEARCH_EVIDENCE_INSUFFICIENT");
    expect(dependencies.retrievalCalls).toBeGreaterThanOrEqual(3);
  });

  test("interrupts for approval and resumes from the same checkpoint", async () => {
    const config = { ...baseConfig, requiresApproval: true };
    const dependencies = createDependencies({ config });
    const first = await invokeResearchGraph({
      graph: dependencies.graph,
      input: input({ config }),
      threadId,
    });
    expect(first.interrupted).toBe(true);
    expect(first.interrupt).toMatchObject({ type: "research_approval" });
    expect(dependencies.saved).toHaveLength(0);

    const second = await invokeResearchGraph({
      graph: dependencies.graph,
      input: input({ config }),
      threadId,
      resume: { approved: true },
    });
    expect(second.interrupted).toBe(false);
    expect(second.state.status).toBe("completed");
    expect(dependencies.saved).toHaveLength(1);
  });

  test("returns to retrieval when approval is rejected with feedback", async () => {
    const config = { ...baseConfig, requiresApproval: true };
    const dependencies = createDependencies({ config });
    await invokeResearchGraph({
      graph: dependencies.graph,
      input: input({ config }),
      threadId,
    });
    const rejected = await invokeResearchGraph({
      graph: dependencies.graph,
      input: input({ config }),
      threadId,
      resume: { approved: false, feedback: "Focus on shade." },
    });
    expect(rejected.interrupted).toBe(true);
    expect(dependencies.retrievalCalls).toBeGreaterThanOrEqual(2);
  });

  test("falls back to a deterministic plan without a model", async () => {
    const state = await planNode(
      {
        question,
        config: baseConfig,
      },
      { llm: null },
    );
    expect(state.queries[0]).toBe(question);
    expect(state.plan.length).toBeGreaterThan(0);
  });

  test("assembles context within a token budget and preserves provenance", () => {
    const context = assembleContext({
      sources: [
        {
          sourceId: "source-1",
          url: "https://example.test/1",
          title: "Source",
          snippet: "x".repeat(4_000),
          trust: "untrusted",
          provenance: {
            provider: "mcp",
            tool: "web_search",
            retrievedAt: "2026-10-31T00:00:00.000Z",
          },
        },
      ],
      chunks: [
        {
          chunkId,
          documentId,
          content: "y".repeat(400),
          score: 1,
          metadata: {},
        },
      ],
      graphEvidence: {
        entities: [{ name: "Urban Trees", kind: "concept" }],
        relationships: [],
      },
      maxTokens: 200,
    });
    expect(context.usedTokens).toBeLessThanOrEqual(200);
    expect(context.sourceIds).toEqual(["source-1"]);
    expect(context.text).toContain("untrusted-data");
  });
});
