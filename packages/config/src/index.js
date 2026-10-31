import { z } from "zod";

const runtimeSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
});

const llmSchema = z.object({
  LLM_BASE_URL: z.string().url(),
  LLM_MODEL_NAME: z.string().min(1),
  LLM_API_KEY: z.string().min(1),
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
  };
}
