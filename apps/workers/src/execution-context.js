import { UnrecoverableError } from "bullmq";
import { taskCancellationKey } from "@evidencegraph/queue";

function waitForDelay(milliseconds, signal) {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const abort = () => {
      clearTimeout(timer);
      reject(new Error("Worker execution was aborted."));
    };
    const timer = setTimeout(finish, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export function createExecutionContext({
  job,
  redis,
  signal,
  executionId,
  simulatedStageDelayMs,
}) {
  async function throwIfCancelled() {
    if ((await redis.exists(taskCancellationKey(job.id))) === 1) {
      throw new UnrecoverableError("TASK_CANCELLED");
    }
    if (signal?.aborted) {
      throw new Error("Worker execution was aborted.");
    }
  }

  async function reportProgress({ percent, stage, message }) {
    await throwIfCancelled();
    await job.updateProgress({ percent, stage, message, executionId });
  }

  async function waitForStage() {
    await throwIfCancelled();
    await waitForDelay(simulatedStageDelayMs, signal);
    await throwIfCancelled();
  }

  return {
    executionId,
    reportProgress,
    signal,
    throwIfCancelled,
    waitForStage,
  };
}
