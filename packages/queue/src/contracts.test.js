import { describe, expect, test } from "bun:test";
import {
  documentJobSchema,
  queueOptionsSchema,
  researchEventSchema,
  researchJobSchema,
} from "./contracts.js";

const owner = { userId: "test-user", workspaceId: "test-workspace" };
const taskId = "00000000-0000-4000-8000-000000000001";
const validResearchJob = {
  taskId,
  question: "How do urban trees affect summer temperatures?",
  config: {
    depth: "standard",
    maxSources: 10,
    maxIterations: 3,
    maxDurationSeconds: 120,
  },
  owner,
  fingerprint: "a".repeat(64),
};

describe("BullMQ payload contracts", () => {
  test("accepts a valid research job and rejects malformed ownership", () => {
    expect(researchJobSchema.parse(validResearchJob)).toEqual(validResearchJob);
    expect(() =>
      researchJobSchema.parse({
        ...validResearchJob,
        owner: { ...owner, isAdmin: true },
      }),
    ).toThrow();
  });

  test("defaults queue options and bounds priority and delay", () => {
    expect(queueOptionsSchema.parse({})).toEqual({ priority: 0, delayMs: 0 });
    expect(queueOptionsSchema.parse({ priority: 1, delayMs: 500 })).toEqual({
      priority: 1,
      delayMs: 500,
    });
    expect(() => queueOptionsSchema.parse({ delayMs: 86_400_001 })).toThrow();
  });

  test("validates discriminated progress-event payloads", () => {
    const event = {
      id: 1,
      taskId,
      timestamp: new Date().toISOString(),
      type: "research.progress",
      data: { percent: 50, message: "Halfway through the task." },
    };

    expect(researchEventSchema.parse(event)).toEqual(event);
    expect(() =>
      researchEventSchema.parse({
        ...event,
        data: { percent: 101, message: "Invalid progress." },
      }),
    ).toThrow();
  });

  test("validates cancellation requests and execution IDs in progress events", () => {
    const executionId = "00000000-0000-4000-8000-000000000002";
    const cancellationEvent = {
      id: 2,
      taskId,
      timestamp: new Date().toISOString(),
      type: "task.cancellation_requested",
      data: { status: "processing", cancellationRequested: true },
    };
    expect(researchEventSchema.parse(cancellationEvent)).toEqual(
      cancellationEvent,
    );

    const progressEvent = {
      id: 3,
      taskId,
      timestamp: new Date().toISOString(),
      type: "research.progress",
      data: {
        percent: 40,
        message: "Reviewing evidence.",
        stage: "evidence-review",
        executionId,
      },
    };
    expect(researchEventSchema.parse(progressEvent)).toEqual(progressEvent);
  });

  test("requires ingestion jobs to reference an opaque document object key", () => {
    const validDocumentJob = {
      documentId: taskId,
      filename: "notes.txt",
      mediaType: "text/plain",
      size: 4,
      objectKey: `documents/${taskId}`,
      owner,
      fingerprint: "b".repeat(64),
    };

    expect(documentJobSchema.parse(validDocumentJob)).toEqual(validDocumentJob);
    expect(() =>
      documentJobSchema.parse({
        ...validDocumentJob,
        objectKey: "documents/../../secrets.txt",
      }),
    ).toThrow();
  });
});
