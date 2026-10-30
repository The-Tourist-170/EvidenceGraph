import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { UnrecoverableError, Worker } from "bullmq";
import { getMinioConfig, getValkeyConfig } from "@evidencegraph/config";
import { createObjectStorage } from "../../object-storage/src/index.js";
import { createApiHandler } from "../../../apps/api/src/app.js";
import {
  createBullMqStore,
  createQueueRuntime,
  createValkeyConnection,
  documentIngestionQueueName,
  researchQueueName,
  workerConcurrency,
  taskCancellationKey,
} from "./index.js";

const integrationEnabled = process.env.RUN_PHASE2_INTEGRATION === "1";
const integrationTest = integrationEnabled ? test : test.skip;
const taskConfig = {
  depth: "standard",
  maxSources: 5,
  maxIterations: 2,
  maxDurationSeconds: 60,
};
const owner = {
  userId: `phase2-${randomUUID()}`,
  workspaceId: `phase2-${randomUUID()}`,
};
const taskIds = [];
const documentIds = [];
let runtime;
let storage;
let store;
let researchWorker;
let documentWorker;
let researchWorkerConnection;
let documentWorkerConnection;

function ownerIndex(kind) {
  const digest = createHash("sha256")
    .update(`${owner.userId}\u0000${owner.workspaceId}`)
    .digest("hex");
  return `evidencegraph:${kind}-index:${digest}`;
}

async function waitFor(read, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for queue integration state.");
}

async function closeWorkerConnection(connection) {
  if (!connection) return;
  if (connection.status === "ready") await connection.quit();
  else connection.disconnect();
}

async function removeTaskArtifacts(id) {
  const record = await runtime.redis.hgetall(`evidencegraph:task:${id}`);
  const job = await runtime.researchQueue.getJob(id);
  if (job) await job.remove().catch(() => {});
  const transaction = runtime.redis.multi();
  transaction.del(`evidencegraph:task:${id}`);
  transaction.zrem(ownerIndex("task"), id);
  transaction.del(`evidencegraph:events:${id}`);
  transaction.del(`evidencegraph:event-sequence:${id}`);
  transaction.del(`evidencegraph:event-subscribers:${id}`);
  transaction.del(`evidencegraph:pending-progress:${id}`);
  if (record.idempotencyKeyName) transaction.del(record.idempotencyKeyName);
  await transaction.exec();
}

describe("Phase 2 Valkey and MinIO integration", () => {
  beforeAll(async () => {
    if (!integrationEnabled) return;
    const env = { ...process.env, NODE_ENV: "test" };
    runtime = createQueueRuntime(getValkeyConfig(env));
    storage = createObjectStorage({ config: getMinioConfig(env) });
    store = createBullMqStore({ runtime, objectStorage: storage });
    await Promise.all([store.initialize(), storage.initialize()]);

    researchWorkerConnection = createValkeyConnection(getValkeyConfig(env));
    researchWorker = new Worker(
      researchQueueName,
      async (job) => {
        if (
          job.data.question.includes("phase2:fail-once") &&
          job.attemptsMade === 0
        ) {
          throw new Error("intentional first-attempt integration failure");
        }
        if (
          job.data.question.includes("phase2:always-fail") &&
          !job.data.retryOf
        ) {
          throw new Error("intentional integration failure");
        }
        await job.updateProgress({
          percent: 50,
          message: "Integration worker made progress.",
        });
        if (job.data.question.includes("phase2:hold")) {
          while (
            (await researchWorkerConnection.exists(
              taskCancellationKey(job.id),
            )) === 0
          ) {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          throw new UnrecoverableError("TASK_CANCELLED");
        }
        return {
          summary: `Synthetic integration result for: ${job.data.question}`,
          claims: [],
          sourceIds: [],
          synthetic: true,
        };
      },
      {
        connection: researchWorkerConnection,
        concurrency: workerConcurrency.research,
      },
    );
    documentWorkerConnection = createValkeyConnection(getValkeyConfig(env));
    documentWorker = new Worker(
      documentIngestionQueueName,
      async (job) => {
        const object = await storage.getObject(job.data.objectKey);
        await job.updateProgress({ percent: 100, message: "Object read." });
        return { byteLength: object.bytes.byteLength };
      },
      {
        connection: documentWorkerConnection,
        concurrency: workerConcurrency.documentIngestion,
      },
    );
    await Promise.all([
      researchWorker.waitUntilReady(),
      documentWorker.waitUntilReady(),
    ]);
  }, 30_000);

  afterAll(async () => {
    if (!integrationEnabled) return;
    if (researchWorker) await researchWorker.close();
    if (documentWorker) await documentWorker.close();
    await closeWorkerConnection(researchWorkerConnection);
    await closeWorkerConnection(documentWorkerConnection);
    if (store) {
      for (const id of taskIds) await removeTaskArtifacts(id);
      for (const id of documentIds) {
        await store.deleteDocument(id, owner).catch(() => {});
      }
      await store.close();
    }
  }, 30_000);

  integrationTest(
    "dispatches, deduplicates, retries, cancels, streams, and stores document objects",
    async () => {
      const idempotencyKey = `research-${randomUUID()}`;
      const submission = {
        question: "How do urban trees affect summer temperatures?",
        config: taskConfig,
        queueOptions: { priority: 1, delayMs: 0 },
        owner,
        idempotencyKey,
      };
      const task = await store.createTask(submission);
      taskIds.push(task.id);
      const duplicate = await store.createTask(submission);
      expect(duplicate.id).toBe(task.id);
      await expect(
        store.createTask({
          ...submission,
          question: "A different valid research question?",
        }),
      ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", status: 409 });

      const completed = await waitFor(
        () => store.getTask(task.id, owner),
        (value) => value.status === "completed",
      );
      expect(completed.result?.synthetic).toBe(true);
      expect(await store.getTaskResult(task.id, owner)).toMatchObject({
        synthetic: true,
      });
      const queuedJob = await runtime.researchQueue.getJob(task.id);
      expect(queuedJob.opts.priority).toBe(1);

      const events = await store.getEvents(task.id, owner);
      await waitFor(
        () => events.replay(task.id, null),
        (history) =>
          history.events.some(
            ({ event }) => event.type === "research.progress",
          ),
      );
      const response = await events.createStreamResponse({
        taskId: task.id,
        afterId: null,
        isTerminal: () => store.isTaskTerminal(task.id),
      });
      const reader = response.body.getReader();
      let stream = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        stream += new TextDecoder().decode(value);
      }
      expect(stream).toContain("event: research.progress");
      expect(stream).toContain("event: task.completed");

      const observerRuntime = createQueueRuntime(
        getValkeyConfig({ ...process.env, NODE_ENV: "test" }),
      );
      await observerRuntime.initialize();
      try {
        const observerStore = createBullMqStore({
          runtime: observerRuntime,
          objectStorage: storage,
        });
        const observerHandler = createApiHandler({
          store: observerStore,
          env: { ...process.env, NODE_ENV: "test" },
          authenticate: () => owner,
        });
        const observerResponse = await observerHandler(
          new Request(
            `http://localhost/api/v1/research-tasks/${task.id}/events`,
          ),
        );
        const observerReader = observerResponse.body.getReader();
        let observerStream = "";
        while (true) {
          const { value, done } = await observerReader.read();
          if (done) break;
          observerStream += new TextDecoder().decode(value);
        }
        expect(observerStream).toContain("event: research.progress");
        expect(observerStream).toContain("event: task.completed");
      } finally {
        await observerRuntime.close();
      }

      const delayed = await store.createTask({
        question: "A delayed queue cancellation integration question.",
        config: taskConfig,
        queueOptions: { priority: 3, delayMs: 60_000 },
        owner,
      });
      taskIds.push(delayed.id);
      const delayedJob = await runtime.researchQueue.getJob(delayed.id);
      expect(await delayedJob.getState()).toBe("delayed");
      expect(delayedJob.opts.priority).toBe(3);
      expect((await store.cancelTask(delayed.id, owner)).status).toBe(
        "cancelled",
      );
      expect(await runtime.researchQueue.getJob(delayed.id)).toBeUndefined();

      const held = await store.createTask({
        question: "phase2:hold an active task for cancellation testing",
        config: taskConfig,
        owner,
      });
      taskIds.push(held.id);
      await waitFor(
        () => store.getTask(held.id, owner),
        (value) => value.status === "processing",
      );
      const cancellationRequest = await store.cancelTask(held.id, owner);
      expect(cancellationRequest.status).toBe("processing");
      expect(cancellationRequest.cancellationRequested).toBe(true);
      await waitFor(
        () => store.getTask(held.id, owner),
        (value) => value.status === "cancelled",
      );

      const failOnce = await store.createTask({
        question: "phase2:fail-once and complete after automatic retry",
        config: taskConfig,
        owner,
      });
      taskIds.push(failOnce.id);
      await waitFor(
        () => store.getTask(failOnce.id, owner),
        (value) => value.status === "completed",
      );
      const retriedJob = await runtime.researchQueue.getJob(failOnce.id);
      expect(retriedJob.attemptsMade).toBe(2);

      const failing = await store.createTask({
        question: "phase2:always-fail until BullMQ retries are exhausted",
        config: taskConfig,
        owner,
      });
      taskIds.push(failing.id);
      await waitFor(
        () => store.getTask(failing.id, owner),
        (value) => value.status === "failed",
      );
      const retried = await store.retryTask(failing.id, owner);
      taskIds.push(retried.id);
      expect(retried.retryOf).toBe(failing.id);
      await waitFor(
        () => store.getTask(retried.id, owner),
        (value) => value.status === "completed",
      );

      const bytes = new TextEncoder().encode(
        "Phase 2 MinIO integration content.",
      );
      const documentIdempotencyKey = `document-${randomUUID()}`;
      const document = await store.createDocument({
        filename: "integration.txt",
        mediaType: "text/plain",
        size: bytes.length,
        bytes,
        owner,
        idempotencyKey: documentIdempotencyKey,
      });
      documentIds.push(document.id);
      const duplicateDocument = await store.createDocument({
        filename: "integration.txt",
        mediaType: "text/plain",
        size: bytes.length,
        bytes,
        owner,
        idempotencyKey: documentIdempotencyKey,
      });
      expect(duplicateDocument.id).toBe(document.id);
      const download = await store.getDocumentContent(document.id, owner);
      expect(download.bytes).toEqual(bytes);
      const documentJob = await runtime.documentQueue.getJob(document.id);
      expect(documentJob.data).not.toHaveProperty("bytes");
      expect(documentJob.data.objectKey).toBe(`documents/${document.id}`);
      await waitFor(
        () => store.getDocument(document.id, owner),
        (value) => value.status === "completed",
      );
      await store.deleteDocument(document.id, owner);
    },
    60_000,
  );
});
