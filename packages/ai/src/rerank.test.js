import { describe, expect, test } from "bun:test";
import { createReranker, lexicalRerank, lexicalScore } from "./rerank.js";

const config = {
  endpoint: "https://rerank.example.test/v1/rerank",
  modelName: "rerank-fixture",
  apiKey: "secret",
  timeoutMs: 1_000,
  maxCandidates: 10,
};

const documents = [
  { id: "a", text: "Urban trees reduce summer heat." },
  { id: "b", text: "Ocean currents affect rainfall." },
];

function response(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status });
}

describe("reranker", () => {
  test("returns provider scores in descending order", async () => {
    const reranker = createReranker({
      config,
      fetchImpl: async (_url, options) => {
        const body = JSON.parse(options.body);
        expect(body.model).toBe("rerank-fixture");
        expect(body.documents).toEqual([
          "Urban trees reduce summer heat.",
          "Ocean currents affect rainfall.",
        ]);
        return response({
          results: [
            { index: 0, relevance_score: 0.7 },
            { index: 1, relevance_score: 0.95 },
          ],
        });
      },
    });
    const result = await reranker.rerank({
      query: "ocean rainfall",
      documents,
      limit: 2,
    });
    expect(result.fallback).toBe(false);
    expect(result.results).toEqual([
      { id: "b", score: 0.95 },
      { id: "a", score: 0.7 },
    ]);
  });

  test("falls back deterministically when the provider fails", async () => {
    const reranker = createReranker({
      config,
      fetchImpl: async () => response({ error: "unavailable" }, 503),
    });
    const result = await reranker.rerank({
      query: "urban heat",
      documents,
      limit: 1,
    });
    expect(result.fallback).toBe(true);
    expect(result.errorCode).toBe("PROVIDER_UNAVAILABLE");
    expect(result.results).toHaveLength(1);
    expect(result.results[0].id).toBe("a");
  });

  test("uses lexical fallback without a configured provider", async () => {
    const reranker = createReranker({ config: null });
    const result = await reranker.rerank({
      query: "trees heat",
      documents,
      limit: 2,
    });
    expect(reranker.available).toBe(false);
    expect(result.fallback).toBe(true);
    expect(result.results[0].id).toBe("a");
  });

  test("computes deterministic lexical scores", () => {
    expect(
      lexicalScore("trees heat", "urban trees reduce heat"),
    ).toBeGreaterThan(0);
    expect(lexicalScore("ocean", "urban trees reduce heat")).toBe(0);
    expect(lexicalRerank({ query: "heat", documents, limit: 1 })[0].id).toBe(
      "a",
    );
  });
});
