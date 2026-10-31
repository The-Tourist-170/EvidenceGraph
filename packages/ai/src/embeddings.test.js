import { describe, expect, test } from "bun:test";
import { createEmbeddingClient } from "./embeddings.js";
import { IntegrationError } from "./errors.js";

const config = {
  baseUrl: "https://embed.example.test/v1",
  modelName: "embed-fixture",
  apiKey: "secret-key",
  dimensions: 3,
  batchSize: 2,
};

function response(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("embedding client", () => {
  test("embeds in configured batches and validates dimensions", async () => {
    const calls = [];
    const client = createEmbeddingClient({
      config,
      fetchImpl: async (url, options) => {
        const body = JSON.parse(options.body);
        calls.push({ url, body, authorization: options.headers.authorization });
        return response({
          data: body.input.map(() => ({ embedding: [0.1, 0.2, 0.3] })),
          usage: { total_tokens: body.input.length * 5 },
        });
      },
    });
    const vectors = await client.embedDocuments(["a", "b", "c"]);
    expect(vectors).toHaveLength(3);
    expect(calls).toHaveLength(2);
    expect(calls[0].body.input).toEqual(["a", "b"]);
    expect(calls[1].body.input).toEqual(["c"]);
    expect(calls[0].url).toBe("https://embed.example.test/v1/embeddings");
    expect(calls[0].authorization).toBe("Bearer secret-key");
  });

  test("rejects dimension mismatches", async () => {
    const client = createEmbeddingClient({
      config,
      fetchImpl: async () => response({ data: [{ embedding: [0.1, 0.2] }] }),
    });
    await expect(client.embedQuery("a")).rejects.toMatchObject({
      code: "EMBEDDING_DIMENSION_MISMATCH",
    });
  });

  test("classifies authorization failures without retrying", async () => {
    let calls = 0;
    const client = createEmbeddingClient({
      config,
      retryDelayMs: 0,
      fetchImpl: async () => {
        calls += 1;
        return response({ error: "unauthorized" }, 401);
      },
    });
    await expect(client.embedQuery("a")).rejects.toMatchObject({
      code: "PROVIDER_AUTHORIZATION_FAILED",
    });
    expect(calls).toBe(1);
  });

  test("requires a configuration", () => {
    expect(() => createEmbeddingClient({ config: null })).toThrow(
      IntegrationError,
    );
  });
});
