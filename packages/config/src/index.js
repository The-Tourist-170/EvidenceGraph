import { z } from "zod";

const runtimeSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
});

const booleanFlag = z.preprocess((value) => {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes"].includes(normalized)) return true;
    if (["false", "0", "no", ""].includes(normalized)) return false;
  }
  return value;
}, z.boolean());

const optionalUrl = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z
    .string()
    .url()
    .refine((value) => ["http:", "https:"].includes(new URL(value).protocol))
    .optional(),
);

const optionalText = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).optional(),
);

const llmSchema = z.object({
  LLM_BASE_URL: z.string().url(),
  LLM_MODEL_NAME: z.string().min(1),
  LLM_API_KEY: z.string().min(1),
  LLM_TEMPERATURE: z.coerce.number().min(0).max(2).default(0),
  LLM_MAX_OUTPUT_TOKENS: z.coerce
    .number()
    .int()
    .min(1)
    .max(200_000)
    .default(4_096),
  LLM_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(600_000)
    .default(60_000),
  LLM_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  LLM_COST_PER_MILLION_TOKENS: z.coerce.number().min(0).max(10_000).default(0),
});

const integrationSchema = z.object({
  AI_INTEGRATIONS_ENABLED: booleanFlag.default(false),
});

const embeddingSchema = z.object({
  EMBEDDING_BASE_URL: optionalUrl,
  EMBEDDING_MODEL_NAME: optionalText,
  EMBEDDING_API_KEY: optionalText,
  EMBEDDING_BATCH_SIZE: z.coerce.number().int().min(1).max(256).default(32),
});

const rerankSchema = z.object({
  RERANK_ENDPOINT: optionalUrl,
  RERANK_MODEL_NAME: optionalText,
  RERANK_API_KEY: optionalText,
  RERANK_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(120_000)
    .default(15_000),
  RERANK_MAX_CANDIDATES: z.coerce.number().int().min(1).max(1_000).default(50),
});

const mcpSchema = z.object({
  MCP_SEARCH_TRANSPORT: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.enum(["stdio", "http"]).optional(),
  ),
  MCP_SEARCH_COMMAND: optionalText,
  MCP_SEARCH_ARGS: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().optional(),
  ),
  MCP_SEARCH_URL: optionalUrl,
  MCP_SEARCH_TOKEN: optionalText,
  MCP_SEARCH_TOKEN_ENV: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
    .default("MCP_SEARCH_TOKEN"),
  MCP_SEARCH_TOOL: z.string().min(1).default("web_search"),
  MCP_SEARCH_QUERY_FIELD: z.string().min(1).default("query"),
  MCP_SEARCH_LIMIT_FIELD: z.string().min(1).default("limit"),
  MCP_SEARCH_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(120_000)
    .default(15_000),
  MCP_SEARCH_RATE_LIMIT_PER_MINUTE: z.coerce
    .number()
    .int()
    .min(1)
    .max(600)
    .default(30),
  MCP_SEARCH_MAX_RESULTS: z.coerce.number().int().min(1).max(50).default(10),
});

const authSchema = z.object({
  AUTH_SECRET: z.string().min(32),
  AUTH_URL: optionalUrl,
  AUTH_TRUSTED_ORIGINS: optionalText,
  AUTH_ENABLE_SIGN_UP: booleanFlag.default(true),
});

const observabilitySchema = z.object({
  LANGSMITH_TRACING: booleanFlag.default(false),
  LANGSMITH_API_KEY: optionalText,
  LANGSMITH_PROJECT: z.string().min(1).default("evidencegraph"),
  LANGSMITH_ENDPOINT: optionalUrl,
});

const workerSchema = z.object({
  RESEARCH_WORKER_CONCURRENCY: z.coerce
    .number()
    .int()
    .min(1)
    .max(32)
    .default(4),
  DOCUMENT_WORKER_CONCURRENCY: z.coerce
    .number()
    .int()
    .min(1)
    .max(32)
    .default(2),
  DOCUMENT_WORKER_TIMEOUT_SECONDS: z.coerce
    .number()
    .int()
    .min(10)
    .max(1_800)
    .default(300),
  WORKER_LOCK_DURATION_MS: z.coerce
    .number()
    .int()
    .min(500)
    .max(300_000)
    .default(30_000),
  WORKER_STALLED_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(500)
    .max(120_000)
    .default(30_000),
  WORKER_CANCEL_POLL_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(25)
    .max(1_000)
    .default(100),
  WORKER_SHUTDOWN_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(300_000)
    .default(30_000),
  SIMULATED_STAGE_DELAY_MS: z.coerce
    .number()
    .int()
    .min(0)
    .max(5_000)
    .default(150),
});

const valkeySchema = z.object({
  VALKEY_URL: z
    .string()
    .url()
    .refine((value) => ["redis:", "rediss:"].includes(new URL(value).protocol))
    .default("redis://localhost:6380"),
  VALKEY_PASSWORD: z.string().min(1).default("local-dev-password"),
});

const databaseSchema = z.object({
  DATABASE_URL: z
    .string()
    .url()
    .refine((value) =>
      ["postgres:", "postgresql:"].includes(new URL(value).protocol),
    )
    .default(
      "postgres://evidencegraph:local-dev-password@localhost:5433/evidencegraph",
    ),
});

const qdrantSchema = z.object({
  QDRANT_URL: z
    .string()
    .url()
    .refine((value) => ["http:", "https:"].includes(new URL(value).protocol))
    .default("http://localhost:6335"),
  QDRANT_API_KEY: z.string().min(1).optional(),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().min(1).max(4096).default(1536),
});

const neo4jSchema = z.object({
  NEO4J_URI: z
    .string()
    .url()
    .refine((value) =>
      ["bolt:", "neo4j:", "neo4j+s:", "neo4j+ssc:"].includes(
        new URL(value).protocol,
      ),
    )
    .default("bolt://localhost:7688"),
  NEO4J_AUTH: z.string().min(3).default("neo4j/local-dev-password"),
});

const minioSchema = z.object({
  MINIO_ENDPOINT: z
    .string()
    .url()
    .refine((value) => ["http:", "https:"].includes(new URL(value).protocol))
    .default("http://localhost:9000"),
  MINIO_ACCESS_KEY: z.string().min(1).default("evidencegraph"),
  MINIO_SECRET_KEY: z.string().min(8).default("local-dev-password"),
  MINIO_BUCKET: z
    .string()
    .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/)
    .default("evidencegraph-documents"),
});

/**
 * @typedef {import("zod").infer<typeof runtimeSchema>} RuntimeConfig
 * @typedef {{ baseUrl: string, modelName: string, apiKey: string }} LlmConfig
 * @typedef {import("zod").infer<typeof workerSchema>} WorkerConfig
 * @typedef {{ url: string }} DatabaseConfig
 * @typedef {{ url: string, apiKey?: string, dimensions: number }} QdrantConfig
 * @typedef {{ uri: string, username: string, password: string }} Neo4jConfig
 */

/**
 * @param {Record<string, string | undefined>} [env=process.env]
 * @returns {RuntimeConfig}
 */
export function getRuntimeConfig(env = process.env) {
  const result = runtimeSchema.safeParse(env);
  if (!result.success) {
    throw new Error(
      `Invalid runtime configuration: ${result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
    );
  }
  return result.data;
}

/**
 * @param {Record<string, string | undefined>} [env=process.env]
 * @returns {WorkerConfig}
 */
export function getWorkerConfig(env = process.env) {
  const result = workerSchema.safeParse(env);
  if (!result.success) {
    const invalidVariables = result.error.issues.map((issue) =>
      issue.path.join("."),
    );
    throw new Error(
      `Invalid worker configuration: ${invalidVariables.join(", ")}.`,
    );
  }
  return {
    researchConcurrency: result.data.RESEARCH_WORKER_CONCURRENCY,
    documentConcurrency: result.data.DOCUMENT_WORKER_CONCURRENCY,
    documentTimeoutSeconds: result.data.DOCUMENT_WORKER_TIMEOUT_SECONDS,
    lockDurationMs: result.data.WORKER_LOCK_DURATION_MS,
    stalledIntervalMs: result.data.WORKER_STALLED_INTERVAL_MS,
    cancellationPollIntervalMs: result.data.WORKER_CANCEL_POLL_INTERVAL_MS,
    shutdownTimeoutMs: result.data.WORKER_SHUTDOWN_TIMEOUT_MS,
    simulatedStageDelayMs: result.data.SIMULATED_STAGE_DELAY_MS,
  };
}

export function getValkeyConfig(env = process.env) {
  if (env.NODE_ENV === "production") {
    const missing = ["VALKEY_URL", "VALKEY_PASSWORD"].filter(
      (key) => !env[key],
    );
    if (missing.length > 0) {
      throw new Error(`Missing Valkey configuration: ${missing.join(", ")}.`);
    }
  }

  const result = valkeySchema.safeParse(env);
  if (!result.success) {
    const invalidVariables = result.error.issues.map((issue) =>
      issue.path.join("."),
    );
    throw new Error(
      `Invalid Valkey configuration: ${invalidVariables.join(", ")}.`,
    );
  }
  return {
    url: result.data.VALKEY_URL,
    password: result.data.VALKEY_PASSWORD,
  };
}

/**
 * @param {Record<string, string | undefined>} [env=process.env]
 * @returns {DatabaseConfig}
 */
export function getDatabaseConfig(env = process.env) {
  if (env.NODE_ENV === "production" && !env.DATABASE_URL) {
    throw new Error("Missing database configuration: DATABASE_URL.");
  }
  const result = databaseSchema.safeParse(env);
  if (!result.success) {
    throw new Error("Invalid database configuration: DATABASE_URL.");
  }
  return { url: result.data.DATABASE_URL };
}

/**
 * @param {Record<string, string | undefined>} [env=process.env]
 * @returns {QdrantConfig}
 */
export function getQdrantConfig(env = process.env) {
  if (env.NODE_ENV === "production" && !env.QDRANT_URL) {
    throw new Error("Missing vector database configuration: QDRANT_URL.");
  }
  const result = qdrantSchema.safeParse(env);
  if (!result.success) {
    const invalid = result.error.issues.map((issue) => issue.path.join("."));
    throw new Error(
      `Invalid vector database configuration: ${invalid.join(", ")}.`,
    );
  }
  return {
    url: result.data.QDRANT_URL,
    apiKey: result.data.QDRANT_API_KEY,
    dimensions: result.data.EMBEDDING_DIMENSIONS,
  };
}

/**
 * @param {Record<string, string | undefined>} [env=process.env]
 * @returns {Neo4jConfig}
 */
export function getNeo4jConfig(env = process.env) {
  if (env.NODE_ENV === "production") {
    const missing = ["NEO4J_URI", "NEO4J_AUTH"].filter((key) => !env[key]);
    if (missing.length > 0) {
      throw new Error(
        `Missing graph database configuration: ${missing.join(", ")}.`,
      );
    }
  }
  const result = neo4jSchema.safeParse(env);
  if (!result.success) {
    const invalid = result.error.issues.map((issue) => issue.path.join("."));
    throw new Error(
      `Invalid graph database configuration: ${invalid.join(", ")}.`,
    );
  }
  const separator = result.data.NEO4J_AUTH.indexOf("/");
  if (separator < 1 || separator === result.data.NEO4J_AUTH.length - 1) {
    throw new Error("Invalid graph database configuration: NEO4J_AUTH.");
  }
  return {
    uri: result.data.NEO4J_URI,
    username: result.data.NEO4J_AUTH.slice(0, separator),
    password: result.data.NEO4J_AUTH.slice(separator + 1),
  };
}

export function getMinioConfig(env = process.env) {
  if (env.NODE_ENV === "production") {
    const missing = [
      "MINIO_ENDPOINT",
      "MINIO_ACCESS_KEY",
      "MINIO_SECRET_KEY",
      "MINIO_BUCKET",
    ].filter((key) => !env[key]);
    if (missing.length > 0) {
      throw new Error(
        `Missing object-storage configuration: ${missing.join(", ")}.`,
      );
    }
  }

  const result = minioSchema.safeParse(env);
  if (!result.success) {
    const invalidVariables = result.error.issues.map((issue) =>
      issue.path.join("."),
    );
    throw new Error(
      `Invalid object-storage configuration: ${invalidVariables.join(", ")}.`,
    );
  }
  return {
    endpoint: result.data.MINIO_ENDPOINT,
    accessKeyId: result.data.MINIO_ACCESS_KEY,
    secretAccessKey: result.data.MINIO_SECRET_KEY,
    bucket: result.data.MINIO_BUCKET,
  };
}

/**
 * @param {Record<string, string | undefined>} [env=process.env]
 * @returns {LlmConfig}
 */
export function getLlmConfig(env = process.env) {
  const result = llmSchema.safeParse(env);
  if (!result.success) {
    const missingVariables = [
      ...new Set(result.error.issues.map((issue) => issue.path.join("."))),
    ];
    throw new Error(
      `Missing or invalid LLM configuration: ${missingVariables.join(", ")}. Set these variables in your .env file; see .env.example.`,
    );
  }
  return {
    baseUrl: result.data.LLM_BASE_URL,
    modelName: result.data.LLM_MODEL_NAME,
    apiKey: result.data.LLM_API_KEY,
    temperature: result.data.LLM_TEMPERATURE,
    maxOutputTokens: result.data.LLM_MAX_OUTPUT_TOKENS,
    timeoutMs: result.data.LLM_TIMEOUT_MS,
    maxRetries: result.data.LLM_MAX_RETRIES,
    costPerMillionTokens: result.data.LLM_COST_PER_MILLION_TOKENS,
  };
}

/**
 * Whether the worker should build real external integrations. Production is
 * always enabled so a missing provider fails visibly instead of silently
 * falling back to synthetic output.
 * @param {Record<string, string | undefined>} [env=process.env]
 */
export function getIntegrationConfig(env = process.env) {
  const result = integrationSchema.safeParse(env);
  if (!result.success) {
    throw new Error("Invalid integration configuration.");
  }
  return {
    enabled:
      env.NODE_ENV === "production" ||
      result.data.AI_INTEGRATIONS_ENABLED === true,
  };
}

/**
 * @param {Record<string, string | undefined>} [env=process.env]
 * @returns {{ baseUrl: string, modelName: string, apiKey: string, dimensions: number, batchSize: number } | null}
 */
export function getEmbeddingConfig(env = process.env) {
  const result = embeddingSchema.safeParse(env);
  if (!result.success) {
    const invalid = result.error.issues.map((issue) => issue.path.join("."));
    throw new Error(`Invalid embedding configuration: ${invalid.join(", ")}.`);
  }
  if (!result.data.EMBEDDING_MODEL_NAME) return null;
  const baseUrl = result.data.EMBEDDING_BASE_URL ?? env.LLM_BASE_URL;
  const apiKey = result.data.EMBEDDING_API_KEY ?? env.LLM_API_KEY;
  if (!baseUrl || !apiKey) {
    const missing = [
      !baseUrl ? "EMBEDDING_BASE_URL (or LLM_BASE_URL)" : null,
      !apiKey ? "EMBEDDING_API_KEY (or LLM_API_KEY)" : null,
    ].filter(Boolean);
    throw new Error(`Missing embedding configuration: ${missing.join(", ")}.`);
  }
  const qdrant = qdrantSchema.safeParse(env);
  if (!qdrant.success) {
    throw new Error("Invalid embedding configuration: EMBEDDING_DIMENSIONS.");
  }
  return {
    baseUrl,
    modelName: result.data.EMBEDDING_MODEL_NAME,
    apiKey,
    dimensions: qdrant.data.EMBEDDING_DIMENSIONS,
    batchSize: result.data.EMBEDDING_BATCH_SIZE,
  };
}

/**
 * @param {Record<string, string | undefined>} [env=process.env]
 * @returns {{ endpoint: string, modelName: string, apiKey?: string, timeoutMs: number, maxCandidates: number } | null}
 */
export function getRerankConfig(env = process.env) {
  const result = rerankSchema.safeParse(env);
  if (!result.success) {
    const invalid = result.error.issues.map((issue) => issue.path.join("."));
    throw new Error(`Invalid rerank configuration: ${invalid.join(", ")}.`);
  }
  if (!result.data.RERANK_ENDPOINT || !result.data.RERANK_MODEL_NAME) {
    return null;
  }
  return {
    endpoint: result.data.RERANK_ENDPOINT,
    modelName: result.data.RERANK_MODEL_NAME,
    apiKey: result.data.RERANK_API_KEY,
    timeoutMs: result.data.RERANK_TIMEOUT_MS,
    maxCandidates: result.data.RERANK_MAX_CANDIDATES,
  };
}

/**
 * @param {Record<string, string | undefined>} [env=process.env]
 * @returns {{ transport: "stdio" | "http", command?: string, args: string[], url?: string, token?: string, tool: string, timeoutMs: number, rateLimitPerMinute: number, maxResults: number } | null}
 */
export function getMcpSearchConfig(env = process.env) {
  const result = mcpSchema.safeParse(env);
  if (!result.success) {
    const invalid = result.error.issues.map((issue) => issue.path.join("."));
    throw new Error(`Invalid MCP search configuration: ${invalid.join(", ")}.`);
  }
  const data = result.data;
  if (!data.MCP_SEARCH_TRANSPORT) return null;
  if (data.MCP_SEARCH_TRANSPORT === "stdio" && !data.MCP_SEARCH_COMMAND) {
    throw new Error("Missing MCP search configuration: MCP_SEARCH_COMMAND.");
  }
  if (data.MCP_SEARCH_TRANSPORT === "http" && !data.MCP_SEARCH_URL) {
    throw new Error("Missing MCP search configuration: MCP_SEARCH_URL.");
  }
  let args = [];
  if (data.MCP_SEARCH_ARGS) {
    try {
      args = JSON.parse(data.MCP_SEARCH_ARGS);
    } catch {
      throw new Error("Invalid MCP search configuration: MCP_SEARCH_ARGS.");
    }
    if (
      !Array.isArray(args) ||
      args.some((value) => typeof value !== "string")
    ) {
      throw new Error("Invalid MCP search configuration: MCP_SEARCH_ARGS.");
    }
  }
  return {
    transport: data.MCP_SEARCH_TRANSPORT,
    command: data.MCP_SEARCH_COMMAND,
    args,
    url: data.MCP_SEARCH_URL,
    token: data.MCP_SEARCH_TOKEN,
    tokenEnv: data.MCP_SEARCH_TOKEN_ENV,
    tool: data.MCP_SEARCH_TOOL,
    queryField: data.MCP_SEARCH_QUERY_FIELD,
    limitField: data.MCP_SEARCH_LIMIT_FIELD,
    timeoutMs: data.MCP_SEARCH_TIMEOUT_MS,
    rateLimitPerMinute: data.MCP_SEARCH_RATE_LIMIT_PER_MINUTE,
    maxResults: data.MCP_SEARCH_MAX_RESULTS,
  };
}

/**
 * @param {Record<string, string | undefined>} [env=process.env]
 * @returns {{ enabled: boolean, apiKey?: string, project: string, endpoint?: string }}
 */
export function getAuthConfig(env = process.env) {
  if (env.NODE_ENV === "production") {
    const missing = ["AUTH_SECRET", "AUTH_URL"].filter((key) => !env[key]);
    if (missing.length > 0) {
      throw new Error(
        `Missing authentication configuration: ${missing.join(", ")}.`,
      );
    }
  }
  const secret =
    env.AUTH_SECRET || "local-development-auth-secret-minimum-32-chars";
  const result = authSchema.safeParse({ ...env, AUTH_SECRET: secret });
  if (!result.success) {
    const invalid = result.error.issues.map((issue) => issue.path.join("."));
    throw new Error(
      `Invalid authentication configuration: ${invalid.join(", ")}.`,
    );
  }
  const fromEnv = (result.data.AUTH_TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const devDefaults =
    env.NODE_ENV === "production"
      ? []
      : ["http://localhost:3001", "http://127.0.0.1:3001"];
  const trustedOrigins = [...new Set([...fromEnv, ...devDefaults])];
  return {
    secret: result.data.AUTH_SECRET,
    url: result.data.AUTH_URL ?? `http://localhost:${env.PORT ?? 3000}`,
    trustedOrigins,
    enableSignUp: result.data.AUTH_ENABLE_SIGN_UP,
  };
}

export function getObservabilityConfig(env = process.env) {
  const result = observabilitySchema.safeParse(env);
  if (!result.success) {
    const invalid = result.error.issues.map((issue) => issue.path.join("."));
    throw new Error(
      `Invalid observability configuration: ${invalid.join(", ")}.`,
    );
  }
  if (result.data.LANGSMITH_TRACING && !result.data.LANGSMITH_API_KEY) {
    throw new Error("Missing observability configuration: LANGSMITH_API_KEY.");
  }
  return {
    enabled: result.data.LANGSMITH_TRACING,
    apiKey: result.data.LANGSMITH_API_KEY,
    project: result.data.LANGSMITH_PROJECT,
    endpoint: result.data.LANGSMITH_ENDPOINT,
  };
}
