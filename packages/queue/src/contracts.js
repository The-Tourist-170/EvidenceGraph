import { z } from "zod";

export const taskConfigSchema = z
  .object({
    depth: z.enum(["quick", "standard", "deep"]),
    maxSources: z.number().int().min(1).max(50),
    maxIterations: z.number().int().min(1).max(10),
    maxDurationSeconds: z.number().int().min(10).max(300),
  })
  .strict();

const ownerSchema = z
  .object({ userId: z.string().min(1), workspaceId: z.string().min(1) })
  .strict();

export const researchJobSchema = z
  .object({
    taskId: z.string().uuid(),
    question: z.string().min(10).max(2_000),
    config: taskConfigSchema,
    owner: ownerSchema,
    fingerprint: z.string().length(64),
    retryOf: z.string().uuid().optional(),
  })
  .strict();

export const documentJobSchema = z
  .object({
    documentId: z.string().uuid(),
    filename: z.string().min(1).max(128),
    mediaType: z.enum([
      "application/pdf",
      "text/plain",
      "text/markdown",
      "text/x-markdown",
    ]),
    size: z.number().int().positive().max(5_242_880),
    objectKey: z.string().regex(/^documents\/[0-9a-f-]{36}$/),
    owner: ownerSchema,
    fingerprint: z.string().length(64),
  })
  .strict();

export const queueOptionsSchema = z
  .object({
    priority: z.number().int().min(0).max(10).default(0),
    delayMs: z.number().int().min(0).max(86_400_000).default(0),
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
