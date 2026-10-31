import { z } from "zod";
import {
  researchEventSchema,
  researchEventTypeSchema,
} from "@evidencegraph/queue/contracts";

export { researchEventSchema, researchEventTypeSchema };

export const researchConfigSchema = z
  .object({
    depth: z.enum(["quick", "standard", "deep"]).default("standard"),
    maxSources: z.number().int().min(1).max(50).default(10),
    maxIterations: z.number().int().min(1).max(10).default(3),
    maxDurationSeconds: z.number().int().min(10).max(300).default(120),
  })
  .strict();

export const createResearchTaskSchema = z
  .object({
    question: z.string().trim().min(10).max(2_000),
    config: researchConfigSchema.default({}),
    queueOptions: z
      .object({
        priority: z.number().int().min(0).max(10).default(0),
        delayMs: z.number().int().min(0).max(86_400_000).default(0),
      })
      .strict()
      .default({}),
  })
  .strict();

export const taskStatusSchema = z.enum([
  "queued",
  "processing",
  "completed",
  "failed",
  "cancelled",
]);

export const researchResultSchema = z
  .object({
    summary: z.string().min(1),
    claims: z.array(z.string()),
    sourceIds: z.array(z.string()),
    synthetic: z.literal(true),
    executionId: z.string().uuid().optional(),
  })
  .strict();

export const researchTaskSchema = z
  .object({
    id: z.string().uuid(),
    question: z.string(),
    config: researchConfigSchema,
    status: taskStatusSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    retryOf: z.string().uuid().optional(),
    executionId: z.string().uuid().optional(),
    cancellationRequested: z.boolean().optional(),
    result: researchResultSchema.optional(),
  })
  .strict();

export const taskStatusResponseSchema = z
  .object({
    id: z.string().uuid(),
    status: taskStatusSchema,
    updatedAt: z.string().datetime(),
    cancellationRequested: z.boolean().optional(),
  })
  .strict();

export const documentStatusSchema = z.enum([
  "uploaded",
  "queued",
  "processing",
  "completed",
  "failed",
  "cancelled",
]);

export const documentSchema = z
  .object({
    id: z.string().uuid(),
    filename: z.string().min(1),
    mediaType: z.string().min(1),
    size: z.number().int().positive(),
    status: documentStatusSchema,
    createdAt: z.string().datetime(),
  })
  .strict();

export const successEnvelopeSchema = (dataSchema) =>
  z.object({ data: dataSchema }).strict();

export const errorEnvelopeSchema = z
  .object({
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        details: z.unknown().optional(),
      })
      .strict(),
  })
  .strict();
