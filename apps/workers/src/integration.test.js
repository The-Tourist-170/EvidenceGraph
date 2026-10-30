import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  getMinioConfig,
  getValkeyConfig,
  getWorkerConfig,
} from "@evidencegraph/config";
import { createObjectStorage } from "@evidencegraph/object-storage";
import {
  createBullMqStore,
  createQueueRuntime,
  researchQueueName,
} from "@evidencegraph/queue";
import { createApiHandler } from "../../api/src/app.js";
import { executeResearch } from "./executors/research.js";
import { startDocumentIngestionWorker } from "./document-ingestion-worker.js";
import { createWorkerRuntime } from "./worker-runtime.js";
import { startResearchWorker } from "./research-worker.js";

const integrationEnabled = process.env.RUN_PHASE3_INTEGRATION === "1";
const phase3Test = integrationEnabled ? test : test.skip;
const owner = {
  userId: `phase3-${randomUUID()}`,
  workspaceId: `phase3-${randomUUID()}`,
};
const taskConfig = {
  depth: "standard",
  maxSources: 5,
  maxIterations: 2,
  maxDurationSeconds: 10,
};
const taskIds = [];
const documentIds = [];
const extraWorkers = [];
let env;
let workerConfig;
let runtime;
let storage;
let store;
let api;
let researchWorker;
let documentWorker;

function taskIndex() {
  const digest = createHash("sha256")
    .update(`${owner.userId}\u0000${owner.workspaceId}`)
    .digest("hex");
  return `evidencegraph:task-index:${digest}`;
}

async function waitFor(read, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for Phase 3 worker state.");
}

async function enqueueResearch(question) {
  const response = await api(
    new Request("http://localhost/api/v1/research-tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question, config: taskConfig }),
    }),
  );
  const body = await response.json();
  if (response.status !== 202) {
    throw new Error(body.error?.message ?? "Research task was not queued.");
  }
  taskIds.push(body.data.id);
  return body.data;
}

async function removeTaskArtifacts(id) {
  const record = await runtime.redis.hgetall(`evidencegraph:task:${id}`);
  const job = await runtime.researchQueue.getJob(id);
  if (job) await job.remove().catch(() => {});
  const transaction = runtime.redis.multi();
  for (const key of [
    `evidencegraph:task:${id}`,
    `evidencegraph:events:${id}`,
    `evidencegraph:event-sequence:${id}`,
    `evidencegraph:event-subscribers:${id}`,
    `evidencegraph:pending-progress:${id}`,
    `evidencegraph:task-cancellation:${id}`,
  ]) {
    transaction.del(key);
  }
  transaction.zrem(taskIndex(), id);
  if (record.idempotencyKeyName) transaction.del(record.idempotencyKeyName);
  await transaction.exec();
}

async function closeExtraWorkers(force = true) {
  for (const worker of [...extraWorkers].reverse()) {
    await worker.close({ force }).catch(() => {});
    const index = extraWorkers.indexOf(worker);
    if (index !== -1) extraWorkers.splice(index, 1);
  }
}

describe("Phase 3 independent workers", () => {
  beforeAll(async () => {
    if (!integrationEnabled) return;
    env = {
      ...process.env,
      NODE_ENV: "test",
      VALKEY_URL: process.env.VALKEY_URL ?? "redis://localhost:6380",
      VALKEY_PASSWORD: process.env.VALKEY_PASSWORD ?? "local-dev-password",
      MINIO_ENDPOINT: process.env.MINIO_ENDPOINT ?? "http://localhost:9000",
      MINIO_ACCESS_KEY: process.env.MINIO_ACCESS_KEY ?? "evidencegraph",
      MINIO_SECRET_KEY: process.env.MINIO_SECRET_KEY ?? "local-dev-password",
      MINIO_BUCKET: process.env.MINIO_BUCKET ?? "evidencegraph-documents",
      SIMULATED_STAGE_DELAY_MS: "250",
      WORKER_CANCEL_POLL_INTERVAL_MS: "25",
      WORKER_LOCK_DURATION_MS: "1000",
      WORKER_STALLED_INTERVAL_MS: "1000",
    };
    workerConfig = getWorkerConfig(env);
    runtime = createQueueRuntime(getValkeyConfig(env));
    storage = createObjectStorage({ config: getMinioConfig(env) });
    store = createBullMqStore({ runtime, objectStorage: storage });
    await Promise.all([store.initialize(), storage.initialize()]);
    api = createApiHandler({ store, env, authenticate: () => owner });
    researchWorker = await startResearchWorker({ env, config: workerConfig });
    documentWorker = await startDocumentIngestionWorker({
      env,
      config: workerConfig,
    });
  }, 30_000);

  afterAll(async () => {
    if (!integrationEnabled) return;
    await closeExtraWorkers(true);
    if (researchWorker) await researchWorker.close();
    if (documentWorker) await documentWorker.close();
    if (store) {
      for (const id of documentIds) {
        await store.deleteDocument(id, owner).catch(() => {});
      }
      for (const id of taskIds) await removeTaskArtifacts(id);
      await store.close();
    }
  }, 60_000);

  phase3Test(
    "runs both independent workers, publishes execution IDs, and acknowledges cancellation",
    async () => {
      const task = await enqueueResearch(
        "How do urban trees reduce summer heat?",
      );
      const completed = await waitFor(
        () => store.getTask(task.id, owner),
        (value) => value.status === "completed",
      );
      expect(completed.result?.synthetic).toBe(true);
      expect(completed.executionId).toMatch(/^[0-9a-f-]{36}$/);

      const eventResponse = await api(
        new Request(`http://localhost/api/v1/research-tasks/${task.id}/events`),
      );
      const eventText = await eventResponse.text();
      expect(eventText).toContain("event: research.progress");
      expect(eventText).toContain("evidence-review");
      expect(eventText).toContain(completed.executionId);
      expect(eventText).toContain("event: task.completed");

      const form = new FormData();
      form.append(
        "file",
        new File(["Phase 3 worker object fixture."], "worker.txt", {
          type: "text/plain",
        }),
      );
      const upload = await api(
        new Request("http://localhost/api/v1/documents", {
          method: "POST",
          body: form,
        }),
      );
      const document = (await upload.json()).data;
      documentIds.push(document.id);
      expect(upload.status).toBe(201);
      const ingested = await waitFor(
        () => store.getDocument(document.id, owner),
        (value) => value.status === "completed",
      );
      expect(ingested.status).toBe("completed");
      const download = await store.getDocumentContent(document.id, owner);
      expect(new TextDecoder().decode(download.bytes)).toBe(
        "Phase 3 worker object fixture.",
      );

      const active = await enqueueResearch(
        "A longer research question for cooperative cancellation?",
      );
      await waitFor(
        () => store.getTask(active.id, owner),
        (value) => value.status === "processing",
      );
      const cancellation = await api(
        new Request(
          `http://localhost/api/v1/research-tasks/${active.id}/cancel`,
          { method: "POST" },
        ),
      );
      expect(cancellation.status).toBe(202);
      expect((await cancellation.json()).data.cancellationRequested).toBe(true);
      const cancelled = await waitFor(
        () => store.getTask(active.id, owner),
        (value) => value.status === "cancelled",
      );
      expect(cancelled.cancellationRequested).toBe(true);
      const history = await (
        await store.getEvents(active.id, owner)
      ).replay(active.id, null);
      expect(history.events.map(({ event }) => event.type)).toContain(
        "task.cancellation_requested",
      );
      expect(history.events.map(({ event }) => event.type)).toContain(
        "task.cancelled",
      );
    },
    60_000,
  );

  phase3Test(
    "drains active work on graceful shutdown, classifies timeouts, and recovers stalled jobs",
    async () => {
      await researchWorker.close();
      researchWorker = null;
      let releaseGraceful;
      const gracefulRuntime = createWorkerRuntime({
        queueName: researchQueueName,
        workerName: "phase3-graceful-shutdown-test",
        concurrency: 1,
        timeoutForJob: () => 60_000,
        processor: async (job, context) => {
          await context.reportProgress({
            percent: 10,
            stage: "shutdown-test",
            message: "Waiting for graceful shutdown release.",
          });
          await new Promise((resolve) => {
            releaseGraceful = resolve;
          });
          return {
            summary: `Synthetic research result for: ${job.data.question}`,
            claims: [],
            sourceIds: [],
            synthetic: true,
          };
        },
        env,
        workerConfig,
      });
      extraWorkers.push(gracefulRuntime);
      await gracefulRuntime.start();
      const gracefulTask = await enqueueResearch(
        "Verify active worker graceful shutdown behavior.",
      );
      await waitFor(
        () => store.getTask(gracefulTask.id, owner),
        (value) => value.status === "processing",
      );
      let closed = false;
      const gracefulClose = gracefulRuntime.close().then(() => {
        closed = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(closed).toBe(false);
      releaseGraceful();
      await gracefulClose;
      extraWorkers.splice(extraWorkers.indexOf(gracefulRuntime), 1);
      await waitFor(
        () => store.getTask(gracefulTask.id, owner),
        (value) => value.status === "completed",
      );

      const timeoutWorker = createWorkerRuntime({
        queueName: researchQueueName,
        workerName: "phase3-timeout-test-worker",
        concurrency: 1,
        timeoutForJob: () => 50,
        processor: (_job, context) => context.waitForStage(),
        env,
        workerConfig,
      });
      extraWorkers.push(timeoutWorker);
      await timeoutWorker.start();
      const timeoutTask = await enqueueResearch(
        "Timeout classification test question?",
      );
      const timedOut = await waitFor(
        () => store.getTask(timeoutTask.id, owner),
        (value) => value.status === "failed",
      );
      const timeoutHistory = await (
        await store.getEvents(timeoutTask.id, owner)
      ).replay(timeoutTask.id, null);
      expect(timeoutHistory.events.at(-1).event.data.code).toBe(
        "TASK_EXECUTION_TIMED_OUT",
      );
      expect(timedOut.status).toBe("failed");
      await timeoutWorker.close();
      extraWorkers.splice(extraWorkers.indexOf(timeoutWorker), 1);

      const interruptedWorker = createWorkerRuntime({
        queueName: researchQueueName,
        workerName: "phase3-interrupted-worker",
        concurrency: 1,
        timeoutForJob: () => 60_000,
        processor: async (_job, context) => {
          await context.reportProgress({
            percent: 5,
            stage: "before-interruption",
            message: "Worker started the recoverable job.",
          });
          return new Promise(() => {});
        },
        env,
        workerConfig: {
          ...workerConfig,
          lockDurationMs: 500,
          stalledIntervalMs: 500,
          simulatedStageDelayMs: 0,
        },
        workerOptions: { lockDuration: 500, stalledInterval: 500 },
      });
      extraWorkers.push(interruptedWorker);
      await interruptedWorker.start();
      const interrupted = await enqueueResearch(
        "Recover this interrupted research job?",
      );
      const firstExecution = await waitFor(
        () => store.getTask(interrupted.id, owner),
        (value) => value.status === "processing" && value.executionId,
      );
      await interruptedWorker.close({ force: true });
      extraWorkers.splice(extraWorkers.indexOf(interruptedWorker), 1);

      const recoveryWorker = createWorkerRuntime({
        queueName: researchQueueName,
        workerName: "phase3-recovery-worker",
        concurrency: 1,
        timeoutForJob: (job) => job.data.config.maxDurationSeconds * 1_000,
        processor: executeResearch,
        env,
        workerConfig: { ...workerConfig, simulatedStageDelayMs: 0 },
        workerOptions: { lockDuration: 500, stalledInterval: 500 },
      });
      extraWorkers.push(recoveryWorker);
      await recoveryWorker.start();
      const recovered = await waitFor(
        () => store.getTask(interrupted.id, owner),
        (value) => value.status === "completed",
        30_000,
      );
      expect(recovered.executionId).not.toBe(firstExecution.executionId);
      const recoveredHistory = await (
        await store.getEvents(interrupted.id, owner)
      ).replay(interrupted.id, null);
      expect(
        new Set(
          recoveredHistory.events
            .filter(({ event }) => event.type === "research.progress")
            .map(({ event }) => event.data.executionId),
        ).size,
      ).toBeGreaterThanOrEqual(2);
      await recoveryWorker.close();
      extraWorkers.splice(extraWorkers.indexOf(recoveryWorker), 1);
    },
    90_000,
  );
});
