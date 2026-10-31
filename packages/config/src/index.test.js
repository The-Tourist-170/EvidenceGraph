import { describe, expect, test } from "bun:test";
import {
  getAuthConfig,
  getDatabaseConfig,
  getEmbeddingConfig,
  getIntegrationConfig,
  getLlmConfig,
  getMcpSearchConfig,
  getObservabilityConfig,
  getRerankConfig,
  getMinioConfig,
  getNeo4jConfig,
  getQdrantConfig,
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

describe("persistence and retrieval configuration", () => {
  test("provides validated local database defaults", () => {
    expect(getDatabaseConfig({ NODE_ENV: "development" })).toEqual({
      url: "postgres://evidencegraph:local-dev-password@localhost:5433/evidencegraph",
    });
  });

  test("requires a database URL in production", () => {
    expect(() => getDatabaseConfig({ NODE_ENV: "production" })).toThrow(
      "DATABASE_URL",
    );
  });

  test("loads vector and graph settings without logging credentials", () => {
    expect(getQdrantConfig({ NODE_ENV: "test" })).toMatchObject({
      url: "http://localhost:6335",
      dimensions: 1536,
    });
    expect(getNeo4jConfig({ NODE_ENV: "test" })).toEqual({
      uri: "bolt://localhost:7688",
      username: "neo4j",
      password: "local-dev-password",
    });
    expect(() =>
      getNeo4jConfig({ NODE_ENV: "test", NEO4J_AUTH: "invalid" }),
    ).toThrow("NEO4J_AUTH");
  });
});

describe("persistence and retrieval configuration", () => {
  test("provides local PostgreSQL settings and requires an explicit production URL", () => {
    expect(getDatabaseConfig({ NODE_ENV: "development" })).toEqual({
      url: "postgres://evidencegraph:local-dev-password@localhost:5433/evidencegraph",
    });
    expect(() => getDatabaseConfig({ NODE_ENV: "production" })).toThrow(
      "DATABASE_URL",
    );
  });

  test("validates Qdrant and Neo4j settings without exposing credentials", () => {
    expect(getQdrantConfig({ NODE_ENV: "test" })).toMatchObject({
      url: "http://localhost:6335",
      dimensions: 1536,
    });
    expect(getNeo4jConfig({ NODE_ENV: "test" })).toEqual({
      uri: "bolt://localhost:7688",
      username: "neo4j",
      password: "local-dev-password",
    });
    expect(() =>
      getNeo4jConfig({ NODE_ENV: "test", NEO4J_AUTH: "invalid" }),
    ).toThrow("NEO4J_AUTH");
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
      temperature: 0,
      maxOutputTokens: 4096,
      timeoutMs: 60_000,
      maxRetries: 2,
      costPerMillionTokens: 0,
    });
  });

  test("reports missing variables without exposing secret values", () => {
    expect(() => getLlmConfig({ LLM_API_KEY: "secret-value" })).toThrow(
      "LLM_BASE_URL, LLM_MODEL_NAME",
    );
  });
});

describe("external integration configuration", () => {
  test("enables integrations in production or by explicit opt-in", () => {
    expect(getIntegrationConfig({ NODE_ENV: "development" }).enabled).toBe(
      false,
    );
    expect(
      getIntegrationConfig({
        NODE_ENV: "development",
        AI_INTEGRATIONS_ENABLED: "true",
      }).enabled,
    ).toBe(true);
    expect(getIntegrationConfig({ NODE_ENV: "production" }).enabled).toBe(true);
  });

  test("returns null for unconfigured optional providers", () => {
    expect(getEmbeddingConfig({})).toBeNull();
    expect(getRerankConfig({})).toBeNull();
    expect(getMcpSearchConfig({})).toBeNull();
  });

  test("builds an embedding configuration with dimensions and batching", () => {
    expect(
      getEmbeddingConfig({
        LLM_BASE_URL: "https://llm.example.test/v1",
        LLM_API_KEY: "llm-key",
        EMBEDDING_MODEL_NAME: "embed-a",
        EMBEDDING_DIMENSIONS: "768",
        EMBEDDING_BATCH_SIZE: "8",
      }),
    ).toEqual({
      baseUrl: "https://llm.example.test/v1",
      modelName: "embed-a",
      apiKey: "llm-key",
      dimensions: 768,
      batchSize: 8,
    });
  });

  test("validates MCP transport-specific settings and JSON arguments", () => {
    expect(
      getMcpSearchConfig({
        MCP_SEARCH_TRANSPORT: "stdio",
        MCP_SEARCH_COMMAND: "server",
        MCP_SEARCH_ARGS: '["--stdio"]',
      }),
    ).toMatchObject({
      transport: "stdio",
      command: "server",
      args: ["--stdio"],
      tool: "web_search",
      queryField: "query",
      limitField: "limit",
    });
    expect(() => getMcpSearchConfig({ MCP_SEARCH_TRANSPORT: "stdio" })).toThrow(
      "MCP_SEARCH_COMMAND",
    );
    expect(() => getMcpSearchConfig({ MCP_SEARCH_TRANSPORT: "http" })).toThrow(
      "MCP_SEARCH_URL",
    );
    expect(() =>
      getMcpSearchConfig({
        MCP_SEARCH_TRANSPORT: "stdio",
        MCP_SEARCH_COMMAND: "server",
        MCP_SEARCH_ARGS: "not-json",
      }),
    ).toThrow("MCP_SEARCH_ARGS");
  });

  test("treats empty optional values as unset", () => {
    expect(
      getMcpSearchConfig({
        MCP_SEARCH_TRANSPORT: "",
        MCP_SEARCH_URL: "",
        MCP_SEARCH_ARGS: "",
      }),
    ).toBeNull();
    expect(
      getEmbeddingConfig({ EMBEDDING_MODEL_NAME: "", EMBEDDING_BASE_URL: "" }),
    ).toBeNull();
  });

  test("requires a LangSmith key when tracing is enabled", () => {
    expect(getObservabilityConfig({ LANGSMITH_TRACING: "false" })).toEqual({
      enabled: false,
      apiKey: undefined,
      project: "evidencegraph",
      endpoint: undefined,
    });
    expect(() => getObservabilityConfig({ LANGSMITH_TRACING: "true" })).toThrow(
      "LANGSMITH_API_KEY",
    );
  });
});

describe("authentication configuration", () => {
  test("provides a development fallback and parses trusted origins", () => {
    expect(
      getAuthConfig({
        NODE_ENV: "test",
        AUTH_SECRET: "x".repeat(40),
        AUTH_TRUSTED_ORIGINS: "http://localhost:3001, https://app.example.test",
        AUTH_ENABLE_SIGN_UP: "false",
      }),
    ).toEqual({
      secret: "x".repeat(40),
      url: "http://localhost:3000",
      trustedOrigins: ["http://localhost:3001", "https://app.example.test"],
      enableSignUp: false,
    });
    expect(
      getAuthConfig({ NODE_ENV: "development" }).secret.length,
    ).toBeGreaterThanOrEqual(32);
  });

  test("fails closed in production without an explicit secret", () => {
    expect(() => getAuthConfig({ NODE_ENV: "production" })).toThrow(
      "AUTH_SECRET",
    );
    expect(() =>
      getAuthConfig({
        NODE_ENV: "production",
        AUTH_SECRET: "short",
        AUTH_URL: "https://app.example.test",
      }),
    ).toThrow("AUTH_SECRET");
    expect(() =>
      getAuthConfig({
        NODE_ENV: "production",
        AUTH_SECRET: "x".repeat(40),
      }),
    ).toThrow("AUTH_URL");
  });
});
