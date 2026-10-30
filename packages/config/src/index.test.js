import { describe, expect, test } from "bun:test";
import {
  getLlmConfig,
  getMinioConfig,
  getRuntimeConfig,
  getValkeyConfig,
  getWorkerConfig,
} from "./index.js";

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

describe("Valkey configuration", () => {
  test("provides local-only development defaults", () => {
    expect(getValkeyConfig({ NODE_ENV: "development" })).toEqual({
      url: "redis://localhost:6380",
      password: "local-dev-password",
    });
  });

  test("requires explicit credentials in production", () => {
    expect(() => getValkeyConfig({ NODE_ENV: "production" })).toThrow(
      "VALKEY_URL, VALKEY_PASSWORD",
    );
  });

  test("rejects unsupported URL schemes without exposing credentials", () => {
    expect(() =>
      getValkeyConfig({
        NODE_ENV: "test",
        VALKEY_URL: "https://cache.example.test",
        VALKEY_PASSWORD: "secret-value",
      }),
    ).toThrow("VALKEY_URL");
  });
});

describe("MinIO configuration", () => {
  test("provides local development settings", () => {
    expect(getMinioConfig({ NODE_ENV: "development" })).toEqual({
      endpoint: "http://localhost:9000",
      accessKeyId: "evidencegraph",
      secretAccessKey: "local-dev-password",
      bucket: "evidencegraph-documents",
    });
  });

  test("requires explicit object storage credentials in production", () => {
    expect(() => getMinioConfig({ NODE_ENV: "production" })).toThrow(
      "MINIO_ENDPOINT, MINIO_ACCESS_KEY, MINIO_SECRET_KEY, MINIO_BUCKET",
    );
  });
});

describe("worker configuration", () => {
  test("provides validated local concurrency and timeout defaults", () => {
    expect(getWorkerConfig({ NODE_ENV: "development" })).toEqual({
      researchConcurrency: 4,
      documentConcurrency: 2,
      documentTimeoutSeconds: 300,
      lockDurationMs: 30_000,
      stalledIntervalMs: 30_000,
      cancellationPollIntervalMs: 100,
      shutdownTimeoutMs: 30_000,
      simulatedStageDelayMs: 150,
    });
  });

  test("coerces worker settings and rejects unsafe concurrency", () => {
    expect(
      getWorkerConfig({ RESEARCH_WORKER_CONCURRENCY: "8" }).researchConcurrency,
    ).toBe(8);
    expect(() => getWorkerConfig({ DOCUMENT_WORKER_CONCURRENCY: "0" })).toThrow(
      "DOCUMENT_WORKER_CONCURRENCY",
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
