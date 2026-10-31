import { describe, expect, test } from "bun:test";
import { IntegrationError } from "./errors.js";
import { createStructuredGenerator, researchSynthesisSchema } from "./llm.js";
import { createMetrics } from "./observability.js";

const config = {
  modelName: "fixture-model",
  temperature: 0,
  maxOutputTokens: 128,
  timeoutMs: 1_000,
  maxRetries: 2,
  costPerMillionTokens: 10,
};

function fakeModel(handler) {
  return {
    withStructuredOutput(schema) {
      return {
        invoke: (messages, options) => handler({ messages, options, schema }),
      };
    },
  };
}

describe("structured LLM generation", () => {
  test("validates structured output and records token metrics", async () => {
    const metrics = createMetrics();
    let received;
    const generator = createStructuredGenerator({
      config,
      metrics,
      retryDelayMs: 0,
      model: fakeModel(async ({ messages }) => {
        received = messages;
        return {
          parsed: {
            summary: "Supported summary.",
            claims: ["A supported claim."],
            sourceIds: ["source-1"],
          },
          raw: { usage_metadata: { total_tokens: 1_000_000 } },
        };
      }),
    });
    const result = await generator.generate({
      schema: researchSynthesisSchema,
      system: "system rules",
      user: "evidence",
      operation: "research_synthesis",
    });

    expect(result.sourceIds).toEqual(["source-1"]);
    expect(received[0]).toEqual({ role: "system", content: "system rules" });
    expect(received[1]).toEqual({ role: "human", content: "evidence" });
    expect(metrics.snapshot()).toMatchObject({
      calls: 1,
      tokens: 1_000_000,
      estimatedCostUsd: 10,
      failures: 0,
    });
  });

  test("retries transient provider failures within the configured budget", async () => {
    let attempts = 0;
    const metrics = createMetrics();
    const generator = createStructuredGenerator({
      config,
      metrics,
      retryDelayMs: 0,
      model: fakeModel(async () => {
        attempts += 1;
        if (attempts < 3) {
          const error = new Error("temporary");
          error.status = 503;
          throw error;
        }
        return {
          parsed: { summary: "ok", claims: [], sourceIds: ["source-1"] },
          raw: {},
        };
      }),
    });
    const result = await generator.generate({
      schema: researchSynthesisSchema,
      system: "system",
      user: "evidence",
    });
    expect(result.summary).toBe("ok");
    expect(attempts).toBe(3);
    expect(metrics.snapshot().retries).toBe(2);
  });

  test("does not retry authorization failures and hides provider details", async () => {
    let attempts = 0;
    const generator = createStructuredGenerator({
      config,
      retryDelayMs: 0,
      model: fakeModel(async () => {
        attempts += 1;
        const error = new Error("raw secret-bearing detail");
        error.status = 401;
        throw error;
      }),
    });
    const error = await generator
      .generate({
        schema: researchSynthesisSchema,
        system: "system",
        user: "evidence",
      })
      .catch((value) => value);
    expect(error).toBeInstanceOf(IntegrationError);
    expect(error.code).toBe("PROVIDER_AUTHORIZATION_FAILED");
    expect(error.message).not.toContain("raw secret-bearing detail");
    expect(attempts).toBe(1);
  });

  test("rejects malformed structured output", async () => {
    const metrics = createMetrics();
    const generator = createStructuredGenerator({
      config,
      metrics,
      retryDelayMs: 0,
      model: fakeModel(async () => ({
        parsed: { summary: "", claims: [], sourceIds: [] },
        raw: {},
      })),
    });
    await expect(
      generator.generate({
        schema: researchSynthesisSchema,
        system: "system",
        user: "evidence",
      }),
    ).rejects.toThrow();
    expect(metrics.snapshot()).toMatchObject({
      failures: 1,
    });
  });
});
