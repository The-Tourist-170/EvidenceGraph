import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  getDatabaseConfig,
  getMinioConfig,
  getNeo4jConfig,
  getQdrantConfig,
  getValkeyConfig,
} from "@evidencegraph/config";
import { createSparseVector } from "@evidencegraph/retrieval";
import { createObjectStorage } from "../../object-storage/src/index.js";
import { createApiHandler } from "../../../apps/api/src/app.js";
import { createQueueRuntime } from "../../queue/src/queues.js";
import { createBullMqStore } from "../../queue/src/store.js";
import { createPostgresPersistence } from "./index.js";

const integrationEnabled = process.env.RUN_PHASE4_INTEGRATION === "1";
const integrationTest = integrationEnabled ? test : test.skip;
const legacyTaskId = randomUUID();
const legacyOwner = {
  userId: `legacy-${randomUUID()}`,
  workspaceId: `legacy-${randomUUID()}`,
};
const taskIds = [];
const documentIds = [];
let env;
let runtime;
let storage;
let persistence;
let store;
let api;
let legacyIdempotencyKey;
let legacyEventKey;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

describe("Phase 4 PostgreSQL, Qdrant, Neo4j, and MinIO integration", () => {
  beforeAll(async () => {
    if (!integrationEnabled) return;
    env = {
      ...process.env,
      NODE_ENV: "test",
      DATABASE_URL:
        process.env.DATABASE_URL ??
        "postgres://evidencegraph:local-dev-password@localhost:5433/evidencegraph",
      VALKEY_URL: process.env.VALKEY_URL ?? "redis://localhost:6380",
      VALKEY_PASSWORD: process.env.VALKEY_PASSWORD ?? "local-dev-password",
      MINIO_ENDPOINT: process.env.MINIO_ENDPOINT ?? "http://localhost:9000",
      MINIO_ACCESS_KEY: process.env.MINIO_ACCESS_KEY ?? "evidencegraph",
      MINIO_SECRET_KEY: process.env.MINIO_SECRET_KEY ?? "local-dev-password",
      MINIO_BUCKET: process.env.MINIO_BUCKET ?? "evidencegraph-documents",
      QDRANT_URL: process.env.QDRANT_URL ?? "http://localhost:6335",
      NEO4J_URI: process.env.NEO4J_URI ?? "bolt://localhost:7688",
      NEO4J_AUTH: process.env.NEO4J_AUTH ?? "neo4j/local-dev-password",
    };
    runtime = createQueueRuntime(getValkeyConfig(env));
    storage = createObjectStorage({ config: getMinioConfig(env) });
    persistence = createPostgresPersistence({
      config: getDatabaseConfig(env),
      env,
      graphConfig: getNeo4jConfig(env),
      vectorConfig: getQdrantConfig(env),
    });
    store = createBullMqStore({
      runtime,
      objectStorage: storage,
      repository: persistence,
    });
    await persistence.database.migrate();
    await Promise.all([store.initialize(), storage.initialize()]);
    api = createApiHandler({ store, env });
  }, 60_000);

  afterAll(async () => {
    if (!integrationEnabled) return;
    if (runtime && legacyIdempotencyKey) {
      await runtime.redis.del(legacyIdempotencyKey);
    }
    if (runtime && legacyEventKey) {
      await runtime.redis.del(legacyEventKey);
      await runtime.redis.del(`evidencegraph:event-sequence:${legacyTaskId}`);
    }
    if (runtime) {
      const digest = sha256(
        `${legacyOwner.userId}\u0000${legacyOwner.workspaceId}`,
      );
      await runtime.redis.del(`evidencegraph:task:${legacyTaskId}`);
      await runtime.redis.zrem(
        `evidencegraph:task-index:${digest}`,
        legacyTaskId,
      );
    }
    if (store) {
      for (const documentId of documentIds) {
        await store
          .deleteDocument(documentId, {
            userId: "local-user",
            workspaceId: "local-workspace",
          })
          .catch(() => {});
      }
      for (const taskId of taskIds) {
        const record = await persistence.getTask(taskId);
        const job = await runtime.researchQueue.getJob(taskId);
        if (job) await job.remove().catch(() => {});
        if (record) await persistence.deleteTask(record);
        await runtime.redis.del(
          `evidencegraph:events:${taskId}`,
          `evidencegraph:event-sequence:${taskId}`,
          `evidencegraph:event-subscribers:${taskId}`,
          `evidencegraph:pending-progress:${taskId}`,
          `evidencegraph:task-cancellation:${taskId}`,
          `evidencegraph:task-initializing:${taskId}`,
          `evidencegraph:task-flushing:${taskId}`,
        );
      }
      const legacy = await persistence.getTask(legacyTaskId);
      if (legacy) await persistence.deleteTask(legacy);
      await store.close();
    }
  }, 60_000);

  integrationTest(
    "persists tasks and documents, imports legacy metadata, and isolates vector/graph data",
    async () => {
      const owner = { userId: "local-user", workspaceId: "local-workspace" };
      const key = `phase4-task-${randomUUID()}`;
      const body = {
        question: "How does PostgreSQL make task state durable?",
        config: {
          depth: "standard",
          maxSources: 5,
          maxIterations: 2,
          maxDurationSeconds: 60,
        },
      };
      const submit = () =>
        api(
          new Request("http://localhost/api/v1/research-tasks", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "idempotency-key": key,
            },
            body: JSON.stringify(body),
          }),
        );
      const first = await submit();
      const task = (await first.json()).data;
      taskIds.push(task.id);
      expect(first.status).toBe(202);
      expect((await submit()).status).toBe(202);
      const persistedTask = await persistence.getTask(task.id);
      expect(persistedTask.question).toBe(body.question);
      expect(persistedTask.owner).toEqual(owner);

      const firstReport = await persistence.saveReport({
        taskId: task.id,
        owner,
        title: "Phase 6 report",
        body: { summary: "First revision." },
      });
      expect(firstReport.currentRevision).toBe(1);
      const secondReport = await persistence.saveReport({
        taskId: task.id,
        owner,
        title: "Phase 6 report",
        body: { summary: "Second revision." },
      });
      expect(secondReport.currentRevision).toBe(2);
      expect((await persistence.getReport(task.id)).body).toEqual({
        summary: "Second revision.",
      });
      const changedRequest = await api(
        new Request("http://localhost/api/v1/research-tasks", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": key,
          },
          body: JSON.stringify({
            ...body,
            question: "A different valid research question?",
          }),
        }),
      );
      expect(changedRequest.status).toBe(409);
      const cancellation = await api(
        new Request(
          `http://localhost/api/v1/research-tasks/${task.id}/cancel`,
          {
            method: "POST",
          },
        ),
      );
      expect((await cancellation.json()).data.status).toBe("cancelled");

      const form = new FormData();
      form.append(
        "file",
        new File(["A durable chunk of evidence for Phase 4."], "phase4.txt", {
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
      const bytes = new TextEncoder().encode(
        "A durable chunk of evidence for Phase 4.",
      );
      const chunks = [
        {
          id: randomUUID(),
          index: 0,
          content: "A durable chunk of evidence for Phase 4.",
          metadata: { startOffset: 0, endOffset: bytes.length },
        },
      ];
      await persistence.saveDocumentChunks(document.id, chunks);
      expect(await persistence.getDocumentChunks(document.id)).toMatchObject(
        chunks,
      );

      await persistence.graphRepository.upsertDocument({
        id: document.id,
        userId: owner.userId,
        workspaceId: owner.workspaceId,
        filename: document.filename,
        mediaType: document.mediaType,
      });
      await persistence.graphRepository.upsertEntities({
        documentId: document.id,
        workspaceId: owner.workspaceId,
        entities: [
          {
            id: randomUUID(),
            name: "Phase Four",
            normalizedName: "phase four",
            kind: "concept",
          },
        ],
      });
      await persistence.graphRepository.upsertEntities({
        documentId: document.id,
        workspaceId: owner.workspaceId,
        entities: [
          {
            id: randomUUID(),
            name: "Summer Heat",
            normalizedName: "summer heat",
            kind: "phenomenon",
          },
        ],
      });
      const claimId = randomUUID();
      await persistence.graphRepository.upsertClaims({
        documentId: document.id,
        workspaceId: owner.workspaceId,
        claims: [
          {
            id: claimId,
            text: "Urban trees reduce summer heat.",
            normalizedText: "urban trees reduce summer heat",
            confidence: 0.9,
            chunkId: chunks[0].id,
          },
        ],
      });
      await persistence.graphRepository.upsertRelationships({
        workspaceId: owner.workspaceId,
        relationships: [
          {
            from: "phase four",
            to: "summer heat",
            type: "REDUCES",
            confidence: 0.8,
          },
        ],
      });
      const entities = await persistence.graphRepository.getDocumentEntities({
        documentId: document.id,
        workspaceId: owner.workspaceId,
      });
      expect(entities).toHaveLength(2);
      expect(
        await persistence.graphRepository.getDocumentClaims({
          documentId: document.id,
          workspaceId: owner.workspaceId,
        }),
      ).toHaveLength(1);
      expect(
        await persistence.graphRepository.getDocumentRelationships({
          workspaceId: owner.workspaceId,
        }),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            from: "phase four",
            to: "summer heat",
            type: "REDUCES",
          }),
        ]),
      );

      const vectorConfig = getQdrantConfig(env);
      const vectorId = randomUUID();
      await persistence.vectorRepository.upsertPoints([
        {
          id: vectorId,
          dense: Array(vectorConfig.dimensions).fill(0.1),
          sparse: { indices: [1, 3], values: [0.4, 0.6] },
          payload: {
            workspaceId: owner.workspaceId,
            userId: owner.userId,
            documentId: document.id,
            chunkId: chunks[0].id,
            content: chunks[0].content,
            metadata: chunks[0].metadata,
          },
        },
      ]);
      const vectorResults = await persistence.vectorRepository.searchDense({
        vector: Array(vectorConfig.dimensions).fill(0.1),
        workspaceId: owner.workspaceId,
        userId: owner.userId,
      });
      expect(vectorResults.map(({ id }) => id)).toContain(vectorId);
      const hybridResults = await persistence.vectorRepository.searchHybrid({
        denseVector: Array(vectorConfig.dimensions).fill(0.1),
        sparseVector: createSparseVector(chunks[0].content),
        workspaceId: owner.workspaceId,
        userId: owner.userId,
        limit: 5,
      });
      expect(hybridResults.map(({ id }) => id)).toContain(vectorId);

      const downloaded = await api(
        new Request(`http://localhost/api/v1/documents/${document.id}/content`),
      );
      expect(await downloaded.text()).toBe(
        "A durable chunk of evidence for Phase 4.",
      );
      const deleted = await api(
        new Request(`http://localhost/api/v1/documents/${document.id}`, {
          method: "DELETE",
        }),
      );
      expect(deleted.status).toBe(200);
      expect(await persistence.getDocument(document.id)).toBeNull();
      expect(
        await persistence.graphRepository.getDocumentEntities({
          documentId: document.id,
          workspaceId: owner.workspaceId,
        }),
      ).toEqual([]);
      expect(
        await persistence.graphRepository.getDocumentClaims({
          documentId: document.id,
          workspaceId: owner.workspaceId,
        }),
      ).toEqual([]);
      const remainingVectors = await persistence.vectorRepository.searchDense({
        vector: Array(vectorConfig.dimensions).fill(0.1),
        workspaceId: owner.workspaceId,
        userId: owner.userId,
      });
      expect(remainingVectors.map(({ id }) => id)).not.toContain(vectorId);

      const legacyOwner = {
        userId: `legacy-${randomUUID()}`,
        workspaceId: `legacy-${randomUUID()}`,
      };
      const legacyFingerprint = "f".repeat(64);
      const legacyKeyName = `evidencegraph:idempotency:research:${sha256(`${legacyOwner.userId}\u0000${legacyOwner.workspaceId}`)}:${sha256("legacy-idempotency")}`;
      legacyIdempotencyKey = legacyKeyName;
      const legacyTask = {
        id: legacyTaskId,
        question: "A task imported from legacy Valkey metadata?",
        config: JSON.stringify(body.config),
        status: "cancelled",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        userId: legacyOwner.userId,
        workspaceId: legacyOwner.workspaceId,
        fingerprint: legacyFingerprint,
        initializing: "0",
        flushing: "0",
        cancellationRequested: "1",
        executionId: "",
        retryOf: "",
        result: "",
        idempotencyKeyName: legacyKeyName,
      };
      await runtime.redis.hset(
        `evidencegraph:task:${legacyTaskId}`,
        legacyTask,
      );
      await runtime.redis.set(
        legacyKeyName,
        JSON.stringify({ fingerprint: legacyFingerprint, id: legacyTaskId }),
        "EX",
        3600,
      );
      const legacyEvent = {
        id: 1,
        taskId: legacyTaskId,
        timestamp: new Date().toISOString(),
        type: "task.cancelled",
        data: { status: "cancelled" },
      };
      legacyEventKey = `evidencegraph:events:${legacyTaskId}`;
      await runtime.redis.xadd(
        legacyEventKey,
        "*",
        "payload",
        JSON.stringify(legacyEvent),
      );
      await persistence.importLegacyRedis(runtime.redis);
      expect((await persistence.getTask(legacyTaskId)).status).toBe(
        "cancelled",
      );
      expect(await persistence.getTaskEvents(legacyTaskId)).toHaveLength(1);
      expect(
        await runtime.redis.hget(`evidencegraph:task:${legacyTaskId}`, "id"),
      ).toBe(legacyTaskId);
    },
    120_000,
  );
});
