import { describe, expect, test } from "bun:test";
import { getLlmConfig, getRuntimeConfig } from "./index.js";

describe("runtime configuration", () => {
  test("applies safe development defaults", () => {
    expect(getRuntimeConfig({})).toEqual({
      NODE_ENV: "development",
      PORT: 3000,
    });
  });

  test("coerces a valid port", () => {
    expect(getRuntimeConfig({ PORT: "4100" }).PORT).toBe(4100);
  });

  test("rejects an invalid port", () => {
    expect(() => getRuntimeConfig({ PORT: "zero" })).toThrow(
      "Invalid runtime configuration",
    );
  });
});

describe("LLM configuration", () => {
  test("maps environment variables to a shared LLM configuration", () => {
    expect(
      getLlmConfig({
        LLM_BASE_URL: "https://llm.example.test/v1",
        LLM_MODEL_NAME: "model-a",
        LLM_API_KEY: "test-key",
      }),
    ).toEqual({
      baseUrl: "https://llm.example.test/v1",
      modelName: "model-a",
      apiKey: "test-key",
    });
  });

  test("reports missing variables without exposing secret values", () => {
    expect(() => getLlmConfig({ LLM_API_KEY: "secret-value" })).toThrow(
      "LLM_BASE_URL, LLM_MODEL_NAME",
    );
  });
});
