import { describe, expect, test } from "bun:test";
import { createExecutionContext } from "./execution-context.js";

const jobId = "00000000-0000-4000-8000-000000000001";
const executionId = "00000000-0000-4000-8000-000000000002";

function createContext({ exists = 0, signal, updateProgress } = {}) {
  const job = { id: jobId, updateProgress: updateProgress ?? (async () => {}) };
  const redis = { exists: async () => exists };
  return createExecutionContext({
    job,
    redis,
    signal,
    executionId,
    simulatedStageDelayMs: 0,
  });
}

describe("worker execution context", () => {
  test("publishes structured progress with a unique execution ID", async () => {
    let progress;
    const context = createContext({
      updateProgress: async (value) => {
        progress = value;
      },
    });

    await context.reportProgress({
      percent: 35,
      stage: "evidence-review",
      message: "Reviewing evidence.",
    });

    expect(progress).toEqual({
      percent: 35,
      stage: "evidence-review",
      message: "Reviewing evidence.",
      executionId,
    });
  });

  test("throws a non-retryable cancellation when Valkey marks the task", async () => {
    const context = createContext({ exists: 1 });
    await expect(context.throwIfCancelled()).rejects.toMatchObject({
      message: "TASK_CANCELLED",
    });
  });

  test("aborts a simulated stage when the Worker signal is cancelled", async () => {
    const controller = new AbortController();
    const context = createExecutionContext({
      job: { id: jobId, updateProgress: async () => {} },
      redis: { exists: async () => 0 },
      signal: controller.signal,
      executionId,
      simulatedStageDelayMs: 500,
    });
    const pending = context.waitForStage();
    controller.abort();

    await expect(pending).rejects.toThrow("aborted");
  });
});
