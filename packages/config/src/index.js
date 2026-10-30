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
 * @returns {LlmConfig}
 */
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
