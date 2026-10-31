import { createHash } from "node:crypto";
import { and, desc, eq, lte } from "drizzle-orm";
import {
  documents,
  documentChunks,
  idempotencyKeys,
  researchTasks,
  taskEvents,
  users,
  workspaceMembers,
  workspaces,
} from "./schema.js";

const idempotencyRetentionSeconds = 7 * 24 * 60 * 60;

export class PersistenceError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "PersistenceError";
    this.status = status;
    this.code = code;
  }
}

function iso(value) {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function taskFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    question: row.question,
    config: row.config,
    status: row.status,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    owner: { userId: row.userId, workspaceId: row.workspaceId },
    fingerprint: row.fingerprint,
    initializing: row.initializing,
    flushing: row.flushing,
    cancellationRequested: row.cancellationRequested,
    ...(row.executionId ? { executionId: row.executionId } : {}),
    ...(row.retryOf ? { retryOf: row.retryOf } : {}),
    ...(row.result ? { result: row.result } : {}),
    ...(row.idempotencyKeyName
      ? { idempotencyKeyName: row.idempotencyKeyName }
      : {}),
  };
}

function documentFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    filename: row.filename,
    mediaType: row.mediaType,
    size: row.size,
    status: row.status,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    objectKey: row.objectKey,
    owner: { userId: row.userId, workspaceId: row.workspaceId },
    fingerprint: row.fingerprint,
    ...(row.idempotencyKeyName
      ? { idempotencyKeyName: row.idempotencyKeyName }
      : {}),
  };
}

function parseJson(value) {
  return value ? JSON.parse(value) : undefined;
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function createPostgresTaskRepository({
  database,
  env = process.env,
} = {}) {
  if (!database) throw new Error("A PostgreSQL database instance is required.");
  const { db } = database;

  async function ensureOwner(owner) {
    const email =
      owner.userId === "local-user"
        ? "local@evidencegraph.test"
        : `${hash(owner.userId)}@external.evidencegraph.invalid`;
    await db
      .insert(users)
      .values({
        id: owner.userId,
        name: owner.userId,
        email,
        emailVerified: false,
      })
      .onConflictDoNothing();
    await db
      .insert(workspaces)
      .values({
        id: owner.workspaceId,
        name:
          owner.workspaceId === "local-workspace"
            ? "Local Workspace"
            : owner.workspaceId,
        slug: `${hash(owner.workspaceId).slice(0, 32)}`,
        createdBy: owner.userId,
      })
      .onConflictDoNothing();
    await db
      .insert(workspaceMembers)
      .values({
        workspaceId: owner.workspaceId,
        userId: owner.userId,
        role: "owner",
      })
      .onConflictDoNothing();
  }

  async function getTask(id) {
    const [row] = await db
      .select()
      .from(researchTasks)
      .where(eq(researchTasks.id, id))
      .limit(1);
    return taskFromRow(row);
  }

  async function saveTask(record) {
    await ensureOwner(record.owner);
    const values = {
      id: record.id,
      userId: record.owner.userId,
      workspaceId: record.owner.workspaceId,
      question: record.question,
      config: record.config,
      status: record.status,
      createdAt: new Date(record.createdAt),
      updatedAt: new Date(record.updatedAt),
      fingerprint: record.fingerprint,
      initializing: Boolean(record.initializing),
      flushing: Boolean(record.flushing),
      cancellationRequested: Boolean(record.cancellationRequested),
      executionId: record.executionId ?? null,
      retryOf: record.retryOf ?? null,
      result: record.result ?? null,
      idempotencyKeyName: record.idempotencyKeyName ?? null,
    };
    const updates = { ...values };
    delete updates.id;
    await db
      .insert(researchTasks)
      .values(values)
      .onConflictDoUpdate({ target: researchTasks.id, set: updates });
  }

  async function setTaskFlags(id, { initializing, flushing }) {
    await db
      .update(researchTasks)
      .set({ initializing, flushing })
      .where(eq(researchTasks.id, id));
  }

  async function deleteTask(record) {
    await db.delete(researchTasks).where(eq(researchTasks.id, record.id));
    if (record.idempotencyKeyName) {
      await db
        .delete(idempotencyKeys)
        .where(eq(idempotencyKeys.keyName, record.idempotencyKeyName));
    }
  }

  async function listTasks(owner, limit) {
    const rows = await db
      .select()
      .from(researchTasks)
      .where(
        and(
          eq(researchTasks.userId, owner.userId),
          eq(researchTasks.workspaceId, owner.workspaceId),
        ),
      )
      .orderBy(desc(researchTasks.createdAt))
      .limit(limit);
    return rows.map(taskFromRow);
  }

  async function getDocument(id) {
    const [row] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, id))
      .limit(1);
    return documentFromRow(row);
  }

  async function saveDocument(record) {
    await ensureOwner(record.owner);
    const values = {
      id: record.id,
      userId: record.owner.userId,
      workspaceId: record.owner.workspaceId,
      filename: record.filename,
      mediaType: record.mediaType,
      size: record.size,
      status: record.status,
      objectKey: record.objectKey,
      fingerprint: record.fingerprint,
      idempotencyKeyName: record.idempotencyKeyName ?? null,
      createdAt: new Date(record.createdAt),
      updatedAt: new Date(record.updatedAt),
    };
    const updates = { ...values };
    delete updates.id;
    await db
      .insert(documents)
      .values(values)
      .onConflictDoUpdate({ target: documents.id, set: updates });
  }

  async function deleteDocument(record) {
    await db.delete(documents).where(eq(documents.id, record.id));
    if (record.idempotencyKeyName) {
      await db
        .delete(idempotencyKeys)
        .where(eq(idempotencyKeys.keyName, record.idempotencyKeyName));
    }
  }

  async function listDocuments(owner, limit) {
    const rows = await db
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.userId, owner.userId),
          eq(documents.workspaceId, owner.workspaceId),
        ),
      )
      .orderBy(desc(documents.createdAt))
      .limit(limit);
    return rows.map(documentFromRow);
  }

  async function reserveIdempotency({
    keyName,
    kind,
    owner,
    fingerprint,
    id,
    retentionSeconds = idempotencyRetentionSeconds,
  }) {
    await ensureOwner(owner);
    const now = new Date();
    await db
      .delete(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.keyName, keyName),
          lte(idempotencyKeys.expiresAt, now),
        ),
      );
    const inserted = await db
      .insert(idempotencyKeys)
      .values({
        keyName,
        resourceType: kind,
        fingerprint,
        resourceId: id,
        userId: owner.userId,
        workspaceId: owner.workspaceId,
        state: "pending",
        createdAt: now,
        expiresAt: new Date(now.getTime() + 30_000),
      })
      .onConflictDoNothing()
      .returning({ keyName: idempotencyKeys.keyName });
    if (inserted.length > 0) {
      return {
        id,
        keyName,
        existing: false,
        async commit(resourceId) {
          await db
            .update(idempotencyKeys)
            .set({
              resourceId,
              state: "committed",
              expiresAt: new Date(Date.now() + retentionSeconds * 1_000),
            })
            .where(eq(idempotencyKeys.keyName, keyName));
        },
        async release() {
          await db
            .delete(idempotencyKeys)
            .where(
              and(
                eq(idempotencyKeys.keyName, keyName),
                eq(idempotencyKeys.state, "pending"),
              ),
            );
        },
      };
    }

    const [row] = await db
      .select()
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.keyName, keyName))
      .limit(1);
    if (!row) {
      throw new PersistenceError(
        409,
        "IDEMPOTENCY_IN_PROGRESS",
        "The request is still being reserved.",
      );
    }
    if (row.fingerprint !== fingerprint) {
      throw new PersistenceError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "This key was used with a different request.",
      );
    }
    if (row.state !== "committed") {
      throw new PersistenceError(
        409,
        "IDEMPOTENCY_IN_PROGRESS",
        "A request with this key is still being processed.",
      );
    }
    const record =
      kind === "research"
        ? await getTask(row.resourceId)
        : await getDocument(row.resourceId);
    if (!record) {
      throw new PersistenceError(
        410,
        "IDEMPOTENCY_RESOURCE_EXPIRED",
        "The idempotency resource is no longer available.",
      );
    }
    return { id: row.resourceId, keyName, record, existing: true };
  }

  async function appendTaskEvent(event) {
    await db
      .insert(taskEvents)
      .values({
        taskId: event.taskId,
        eventId: event.id,
        type: event.type,
        payload: event.data,
        createdAt: new Date(event.timestamp),
      })
      .onConflictDoNothing();
  }

  async function getTaskEvents(taskId) {
    return db
      .select()
      .from(taskEvents)
      .where(eq(taskEvents.taskId, taskId))
      .orderBy(taskEvents.eventId);
  }

  async function getDocumentChunks(documentId) {
    const rows = await db
      .select()
      .from(documentChunks)
      .where(eq(documentChunks.documentId, documentId))
      .orderBy(documentChunks.chunkIndex);
    return rows.map((row) => ({
      id: row.id,
      index: row.chunkIndex,
      content: row.content,
      metadata: row.metadata,
    }));
  }

  async function saveDocumentChunks(documentId, chunks) {
    await db.transaction(async (transaction) => {
      await transaction
        .delete(documentChunks)
        .where(eq(documentChunks.documentId, documentId));
      if (chunks.length > 0) {
        await transaction.insert(documentChunks).values(
          chunks.map((chunk) => ({
            id: chunk.id,
            documentId,
            chunkIndex: chunk.index,
            content: chunk.content,
            metadata: chunk.metadata ?? {},
          })),
        );
      }
    });
  }

  async function importLegacyRedis(legacyRedis) {
    let cursor = "0";
    do {
      const [next, keys] = await legacyRedis.scan(
        cursor,
        "MATCH",
        "evidencegraph:task:????????-????-????-????-????????????",
        "COUNT",
        200,
      );
      cursor = next;
      for (const key of keys) {
        const fields = await legacyRedis.hgetall(key);
        if (!fields.id || !fields.userId || !fields.workspaceId) continue;
        const record = {
          id: fields.id,
          question: fields.question,
          config: parseJson(fields.config),
          status: fields.status,
          createdAt: iso(fields.createdAt),
          updatedAt: iso(fields.updatedAt),
          owner: { userId: fields.userId, workspaceId: fields.workspaceId },
          fingerprint: fields.fingerprint,
          initializing: fields.initializing === "1",
          flushing: fields.flushing === "1",
          cancellationRequested: fields.cancellationRequested === "1",
          ...(fields.executionId ? { executionId: fields.executionId } : {}),
          ...(fields.retryOf ? { retryOf: fields.retryOf } : {}),
          ...(fields.result ? { result: parseJson(fields.result) } : {}),
          ...(fields.idempotencyKeyName
            ? { idempotencyKeyName: fields.idempotencyKeyName }
            : {}),
        };
        await ensureOwner(record.owner);
        const values = {
          id: record.id,
          userId: record.owner.userId,
          workspaceId: record.owner.workspaceId,
          question: record.question,
          config: record.config,
          status: record.status,
          createdAt: new Date(record.createdAt),
          updatedAt: new Date(record.updatedAt),
          fingerprint: record.fingerprint,
          initializing: record.initializing,
          flushing: record.flushing,
          cancellationRequested: record.cancellationRequested,
          executionId: record.executionId ?? null,
          retryOf: record.retryOf ?? null,
          result: record.result ?? null,
          idempotencyKeyName: record.idempotencyKeyName ?? null,
        };
        await db.insert(researchTasks).values(values).onConflictDoNothing();
        const eventRows = await legacyRedis.xrange(
          `evidencegraph:events:${record.id}`,
          "-",
          "+",
        );
        for (const [, eventFields] of eventRows) {
          const fields = Object.fromEntries(
            Array.from({ length: eventFields.length / 2 }, (_, index) => [
              eventFields[index * 2],
              eventFields[index * 2 + 1],
            ]),
          );
          if (fields.payload) {
            await appendTaskEvent(JSON.parse(fields.payload));
          }
        }
      }
    } while (cursor !== "0");

    cursor = "0";
    do {
      const [next, keys] = await legacyRedis.scan(
        cursor,
        "MATCH",
        "evidencegraph:document:????????-????-????-????-????????????",
        "COUNT",
        200,
      );
      cursor = next;
      for (const key of keys) {
        const fields = await legacyRedis.hgetall(key);
        if (!fields.id || !fields.userId || !fields.workspaceId) continue;
        const owner = {
          userId: fields.userId,
          workspaceId: fields.workspaceId,
        };
        await ensureOwner(owner);
        await db
          .insert(documents)
          .values({
            id: fields.id,
            userId: owner.userId,
            workspaceId: owner.workspaceId,
            filename: fields.filename,
            mediaType: fields.mediaType,
            size: Number(fields.size),
            status: fields.status,
            objectKey: fields.objectKey,
            fingerprint: fields.fingerprint,
            idempotencyKeyName: fields.idempotencyKeyName || null,
            createdAt: new Date(fields.createdAt),
            updatedAt: new Date(fields.updatedAt),
          })
          .onConflictDoNothing();
      }
    } while (cursor !== "0");

    cursor = "0";
    do {
      const [next, keys] = await legacyRedis.scan(
        cursor,
        "MATCH",
        "evidencegraph:idempotency:*",
        "COUNT",
        200,
      );
      cursor = next;
      for (const keyName of keys) {
        if (keyName.endsWith(":lock")) continue;
        const raw = await legacyRedis.get(keyName);
        if (!raw) continue;
        let mapping;
        try {
          mapping = JSON.parse(raw);
        } catch {
          continue;
        }
        const parts = keyName.split(":");
        const resourceType = parts[2];
        const record =
          resourceType === "research"
            ? await getTask(mapping.id)
            : await getDocument(mapping.id);
        if (!record) continue;
        const ttl = await legacyRedis.ttl(keyName);
        const expiresAt = new Date(Date.now() + Math.max(ttl, 1) * 1_000);
        await db
          .insert(idempotencyKeys)
          .values({
            keyName,
            resourceType,
            fingerprint: mapping.fingerprint,
            resourceId: mapping.id,
            userId: record.owner.userId,
            workspaceId: record.owner.workspaceId,
            state: "committed",
            expiresAt,
          })
          .onConflictDoNothing();
      }
    } while (cursor !== "0");
  }

  async function initialize({ legacyRedis } = {}) {
    await database.checkHealth();
    await database.verifySchema();
    if (env.NODE_ENV !== "production") {
      await ensureOwner({
        userId: "local-user",
        workspaceId: "local-workspace",
      });
    }
    if (legacyRedis) await importLegacyRedis(legacyRedis);
  }

  return {
    appendTaskEvent,
    async checkHealth() {
      return database.checkHealth();
    },
    close: () => database.close(),
    deleteDocument,
    deleteTask,
    ensureOwner,
    getDocument,
    getDocumentChunks,
    getTask,
    getTaskEvents,
    initialize,
    importLegacyRedis,
    listDocuments,
    listTasks,
    reserveIdempotency,
    saveDocument,
    saveDocumentChunks,
    saveTask,
    setTaskFlags,
  };
}
