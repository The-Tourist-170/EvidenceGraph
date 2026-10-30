import { randomUUID } from "node:crypto";
import { Worker, UnrecoverableError } from "bullmq";
import { getValkeyConfig, getWorkerConfig } from "@evidencegraph/config";
import { logger } from "@evidencegraph/shared";
import { createValkeyConnection } from "@evidencegraph/queue";
import { taskCancellationKey } from "@evidencegraph/queue";
import { createExecutionContext } from "./execution-context.js";

async function closeConnection(connection) {
  if (!connection) return;
  if (connection.status === "ready") await connection.quit();
  else connection.disconnect();
}

export function createWorkerRuntime({
  queueName,
  workerName,
  concurrency,
  timeoutForJob,
  processor,
  objectStorage,
  env = process.env,
  workerConfig: configuredWorker = undefined,
  workerOptions = {},
}) {
  const workerConfig = configuredWorker ?? getWorkerConfig(env);
  const valkeyConfig = getValkeyConfig(env);
  const workerConnection = createValkeyConnection(valkeyConfig);
  const cancellationConnection = createValkeyConnection(valkeyConfig);
  const activeJobs = new Set();
  const timedOutJobs = new Set();
  const jobTimers = new Map();
  let worker;
  let cancellationPollRunning = false;

  worker = new Worker(
    queueName,
    async (job, _token, signal) => {
      const executionId = randomUUID();
      activeJobs.add(job.id);
      logger.info("Worker job started", {
        queue: queueName,
        jobId: job.id,
        executionId,
        attempt: job.attemptsMade + 1,
      });
      const timeoutMs = timeoutForJob(job);
      const timer = setTimeout(() => {
        timedOutJobs.add(job.id);
        worker.cancelJob(job.id, "TASK_TIMED_OUT");
      }, timeoutMs);
      jobTimers.set(job.id, timer);
      const context = createExecutionContext({
        job,
        redis: cancellationConnection,
        signal,
        executionId,
        simulatedStageDelayMs: workerConfig.simulatedStageDelayMs,
      });

      try {
        await context.throwIfCancelled();
        const result = await processor(job, context);
        await context.throwIfCancelled();
        logger.info("Worker job completed", {
          queue: queueName,
          jobId: job.id,
          executionId,
        });
        return result;
      } catch (error) {
        if (timedOutJobs.has(job.id)) {
          throw new UnrecoverableError("TASK_TIMED_OUT");
        }
        if (
          (await cancellationConnection.exists(taskCancellationKey(job.id))) ===
          1
        ) {
          throw new UnrecoverableError("TASK_CANCELLED");
        }
        throw error;
      } finally {
        clearTimeout(timer);
        jobTimers.delete(job.id);
        activeJobs.delete(job.id);
        timedOutJobs.delete(job.id);
      }
    },
    {
      name: workerName,
      connection: workerConnection,
      concurrency,
      lockDuration: workerConfig.lockDurationMs,
      stalledInterval: workerConfig.stalledIntervalMs,
      maxStalledCount: 1,
      ...workerOptions,
    },
  );

  const cancellationPoll = setInterval(() => {
    if (cancellationPollRunning || activeJobs.size === 0) return;
    cancellationPollRunning = true;
    void (async () => {
      for (const jobId of activeJobs) {
        if (
          (await cancellationConnection.exists(taskCancellationKey(jobId))) ===
          1
        ) {
          worker.cancelJob(jobId, "TASK_CANCELLED");
        }
      }
    })()
      .catch(() => {
        logger.error("Worker cancellation poll failed", { queue: queueName });
      })
      .finally(() => {
        cancellationPollRunning = false;
      });
  }, workerConfig.cancellationPollIntervalMs);

  worker.on("error", (error) => {
    logger.error("Worker runtime error", {
      queue: queueName,
      worker: workerName,
      errorCode: error?.code ?? error?.name ?? "WORKER_ERROR",
    });
  });
  worker.on("stalled", (jobId) => {
    logger.error("Worker job stalled", { queue: queueName, jobId });
  });
  worker.on("failed", (job, error) => {
    logger.error("Worker job failed", {
      queue: queueName,
      jobId: job?.id,
      errorCode: error?.message?.includes("TASK_TIMED_OUT")
        ? "TASK_TIMED_OUT"
        : error?.message?.includes("TASK_CANCELLED")
          ? "TASK_CANCELLED"
          : (error?.code ?? "WORKER_JOB_FAILED"),
    });
  });

  let closePromise;
  return {
    worker,
    async start() {
      await Promise.all([
        worker.waitUntilReady(),
        cancellationConnection.ping(),
      ]);
      logger.info("Worker ready", {
        queue: queueName,
        worker: workerName,
        concurrency,
      });
    },
    close({ force = false } = {}) {
      if (!closePromise) {
        closePromise = (async () => {
          clearInterval(cancellationPoll);
          if (force) {
            for (const timer of jobTimers.values()) clearTimeout(timer);
            jobTimers.clear();
          }
          const shutdownTimer = setTimeout(() => {
            logger.error(
              "Worker graceful shutdown is still waiting for active jobs",
              {
                queue: queueName,
                worker: workerName,
              },
            );
          }, workerConfig.shutdownTimeoutMs);
          shutdownTimer.unref?.();
          try {
            await worker.close(force);
          } finally {
            clearTimeout(shutdownTimer);
            await closeConnection(cancellationConnection);
            await closeConnection(workerConnection);
            await objectStorage?.close();
          }
          logger.info("Worker stopped", {
            queue: queueName,
            worker: workerName,
          });
        })();
      }
      return closePromise;
    },
  };
}

export async function startWorkerProcess(options) {
  const runtime = createWorkerRuntime(options);
  try {
    await runtime.start();
  } catch (error) {
    await runtime.close().catch(() => {});
    throw error;
  }

  let shutdownPromise;
  const shutdown = () => {
    if (!shutdownPromise) {
      shutdownPromise = runtime.close().catch((error) => {
        logger.error("Worker shutdown failed", {
          queue: options.queueName,
          errorCode: error?.code ?? error?.name ?? "WORKER_SHUTDOWN_FAILED",
        });
        process.exitCode = 1;
      });
    }
    return shutdownPromise;
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  return { ...runtime, shutdown };
}
