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

/**
 * @typedef {import("zod").infer<typeof runtimeSchema>} RuntimeConfig
 * @typedef {{ baseUrl: string, modelName: string, apiKey: string }} LlmConfig
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
