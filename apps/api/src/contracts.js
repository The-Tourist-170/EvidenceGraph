import { z } from "zod";

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
    result: researchResultSchema.optional(),
  })
  .strict();

export const taskStatusResponseSchema = z
  .object({
    id: z.string().uuid(),
    status: taskStatusSchema,
    updatedAt: z.string().datetime(),
  })
  .strict();

export const documentStatusSchema = z.enum(["uploaded"]);

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

export const researchEventTypeSchema = z.enum([
  "task.created",
  "task.queued",
  "task.processing",
  "research.progress",
  "task.completed",
  "task.failed",
  "task.cancelled",
]);

const researchEventBase = {
  id: z.number().int().positive(),
  taskId: z.string().uuid(),
  timestamp: z.string().datetime(),
};

const taskStateEvent = (type, status) =>
  z
    .object({
      ...researchEventBase,
      type: z.literal(type),
      data: z.object({ status: z.literal(status) }).strict(),
    })
    .strict();

export const researchEventSchema = z.discriminatedUnion("type", [
  taskStateEvent("task.created", "queued"),
  taskStateEvent("task.queued", "queued"),
  taskStateEvent("task.processing", "processing"),
  z
    .object({
      ...researchEventBase,
      type: z.literal("research.progress"),
      data: z
        .object({
          percent: z.number().int().min(0).max(100),
          message: z.string().min(1),
        })
        .strict(),
    })
    .strict(),
  taskStateEvent("task.completed", "completed"),
  z
    .object({
      ...researchEventBase,
      type: z.literal("task.failed"),
      data: z
        .object({ code: z.string().min(1), message: z.string().min(1) })
        .strict(),
    })
    .strict(),
  taskStateEvent("task.cancelled", "cancelled"),
]);

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
