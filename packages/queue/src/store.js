import { createHash, randomUUID } from "node:crypto";
import { logger } from "@evidencegraph/shared";
import { z } from "zod";
import { createRedisEventBroker } from "./event-broker.js";
import {
  documentJobSchema,
  queueOptionsSchema,
  researchJobSchema,
  taskConfigSchema,
} from "./contracts.js";
import { documentIngestionQueueName, researchQueueName } from "./queues.js";

const taskRetentionSeconds = 30 * 24 * 60 * 60;
const eventDeduplicationRetentionSeconds = taskRetentionSeconds;
const idempotencyRetentionSeconds = 7 * 24 * 60 * 60;
const historyLimit = 1_000;
const terminalTaskStatuses = new Set(["completed", "failed", "cancelled"]);
const researchResultSchema = z
  .object({
    summary: z.string().min(1),
    claims: z.array(z.string()),
    sourceIds: z.array(z.string()),
    synthetic: z.literal(true),
  })
  .strict();
const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x21-\x7E]+$/);
const releaseLockScript = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;
const bufferProgressScript = `
if redis.call('HGET', KEYS[1], 'initializing') == '1' or
   redis.call('HGET', KEYS[1], 'flushing') == '1' then
  redis.call('RPUSH', KEYS[2], ARGV[1])
  return 1
end
return 0
`;
const drainProgressScript = `
if redis.call('LLEN', KEYS[2]) == 0 then
  redis.call('HSET', KEYS[1], 'flushing', '0')
  return 'done'
end
local events = redis.call('LRANGE', KEYS[2], 0, -1)
redis.call('DEL', KEYS[2])
return events
`;

export class QueueStoreError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = "QueueStoreError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function deterministicUuid(value) {
  const bytes = createHash("sha256").update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function ownerHash(owner) {
  return sha256(`${owner.userId}\u0000${owner.workspaceId}`);
}

function queueStatus(state) {
  if (state === "active") return "processing";
  if (state === "completed") return "completed";
  if (state === "failed") return "failed";
  return "queued";
}

function normalizedProgress(progress) {
  const rawPercent =
    typeof progress === "number" ? progress : progress?.percent;
  const percent =
    Number.isInteger(rawPercent) && rawPercent >= 0 && rawPercent <= 100
      ? rawPercent
      : 0;
  const message =
    typeof progress?.message === "string" && progress.message.length > 0
      ? progress.message.slice(0, 500)
      : "Research is in progress.";
  return { percent, message };
}

function parseTask(fields) {
  if (!fields.id) return null;
  return {
    id: fields.id,
    question: fields.question,
    config: JSON.parse(fields.config),
    status: fields.status,
    createdAt: fields.createdAt,
    updatedAt: fields.updatedAt,
    owner: { userId: fields.userId, workspaceId: fields.workspaceId },
    fingerprint: fields.fingerprint,
    initializing: fields.initializing === "1",
    flushing: fields.flushing === "1",
    ...(fields.retryOf ? { retryOf: fields.retryOf } : {}),
    ...(fields.result ? { result: JSON.parse(fields.result) } : {}),
    ...(fields.idempotencyKeyName
      ? { idempotencyKeyName: fields.idempotencyKeyName }
      : {}),
  };
}

function parseDocument(fields) {
  if (!fields.id) return null;
  return {
    id: fields.id,
    filename: fields.filename,
    mediaType: fields.mediaType,
    size: Number(fields.size),
    status: fields.status,
    createdAt: fields.createdAt,
    updatedAt: fields.updatedAt,
    objectKey: fields.objectKey,
    owner: { userId: fields.userId, workspaceId: fields.workspaceId },
    fingerprint: fields.fingerprint,
    ...(fields.idempotencyKeyName
      ? { idempotencyKeyName: fields.idempotencyKeyName }
      : {}),
  };
}

function publicTask(record) {
  return {
    id: record.id,
    question: record.question,
    config: record.config,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.retryOf ? { retryOf: record.retryOf } : {}),
    ...(record.result ? { result: record.result } : {}),
  };
}

function publicDocument(record) {
  return {
    id: record.id,
    filename: record.filename,
    mediaType: record.mediaType,
    size: record.size,
    status: record.status,
    createdAt: record.createdAt,
  };
}

function indexKey(kind, owner) {
  return `evidencegraph:${kind}-index:${ownerHash(owner)}`;
}

function assertOwner(record, owner, kind) {
  if (
    !record ||
    record.owner.userId !== owner.userId ||
    record.owner.workspaceId !== owner.workspaceId
  ) {
    throw new QueueStoreError(404, "NOT_FOUND", `${kind} not found.`);
  }
}

export function createBullMqStore({
  runtime,
  objectStorage,
  now = () => new Date(),
}) {
  const {
    redis,
    researchQueue,
    documentQueue,
    researchEvents,
    documentEvents,
  } = runtime;
  const eventBroker = createRedisEventBroker({ redis });

  function taskKey(id) {
    return `evidencegraph:task:${id}`;
  }

  function pendingProgressKey(id) {
    return `evidencegraph:pending-progress:${id}`;
  }

  function documentKey(id) {
    return `evidencegraph:document:${id}`;
  }

  function timestamp() {
    return now().toISOString();
  }

  async function readTask(id) {
    return parseTask(await redis.hgetall(taskKey(id)));
  }

  async function readDocument(id) {
    return parseDocument(await redis.hgetall(documentKey(id)));
  }

  async function saveRecord(kind, record) {
    const key = kind === "task" ? taskKey(record.id) : documentKey(record.id);
    const index = indexKey(kind, record.owner);
    const fields =
      kind === "task"
        ? {
            id: record.id,
            question: record.question,
            config: JSON.stringify(record.config),
            status: record.status,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
            userId: record.owner.userId,
            workspaceId: record.owner.workspaceId,
            fingerprint: record.fingerprint,
            initializing: record.initializing ? "1" : "0",
            flushing: record.flushing ? "1" : "0",
            retryOf: record.retryOf ?? "",
            result: record.result ? JSON.stringify(record.result) : "",
            idempotencyKeyName: record.idempotencyKeyName ?? "",
          }
        : {
            id: record.id,
            filename: record.filename,
            mediaType: record.mediaType,
            size: String(record.size),
            status: record.status,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
            objectKey: record.objectKey,
            userId: record.owner.userId,
            workspaceId: record.owner.workspaceId,
            fingerprint: record.fingerprint,
            idempotencyKeyName: record.idempotencyKeyName ?? "",
          };
    const transaction = redis.multi();
    transaction.hset(key, fields);
    if (kind === "task") transaction.expire(key, taskRetentionSeconds);
    transaction.zadd(index, Date.parse(record.createdAt), record.id);
    if (kind === "task") transaction.expire(index, taskRetentionSeconds);
    const results = await transaction.exec();
    const failure = results?.find(([error]) => error);
    if (failure) throw failure[0];
  }

  async function deleteRecord(kind, record) {
    const key = kind === "task" ? taskKey(record.id) : documentKey(record.id);
    const transaction = redis.multi();
    transaction.del(key);
    transaction.zrem(indexKey(kind, record.owner), record.id);
    if (record.idempotencyKeyName) transaction.del(record.idempotencyKeyName);
    await transaction.exec();
  }

  async function findTask(id, owner) {
    const record = await readTask(id);
    assertOwner(record, owner, "Research task");
    return record;
  }

  async function findDocument(id, owner) {
    const record = await readDocument(id);
    assertOwner(record, owner, "Document");
    return record;
  }

  async function reserveIdempotency(kind, owner, idempotencyKey, fingerprint) {
    if (idempotencyKey === undefined || idempotencyKey === null) {
      return {
        id: randomUUID(),
        keyName: undefined,
        existing: false,
        commit: async () => {},
        release: async () => {},
      };
    }
    const parsedKey = idempotencyKeySchema.safeParse(idempotencyKey);
    if (!parsedKey.success) {
      throw new QueueStoreError(
        400,
        "INVALID_IDEMPOTENCY_KEY",
        "Idempotency-Key must contain 1 to 128 visible ASCII characters.",
      );
    }
    const scope = `${kind}:${ownerHash(owner)}:${sha256(parsedKey.data)}`;
    const keyName = `evidencegraph:idempotency:${scope}`;
    const lockName = `${keyName}:lock`;
    const currentValue = await redis.get(keyName);
    if (currentValue) {
      const current = JSON.parse(currentValue);
      if (current.fingerprint !== fingerprint) {
        throw new QueueStoreError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "This idempotency key was already used with a different request.",
        );
      }
      const record =
        kind === "research"
          ? await readTask(current.id)
          : await readDocument(current.id);
      if (!record) {
        throw new QueueStoreError(
          410,
          "IDEMPOTENCY_RESOURCE_EXPIRED",
          "The resource associated with this idempotency key has expired.",
        );
      }
      return { id: current.id, keyName, record, existing: true };
    }

    const lockToken = randomUUID();
    const acquired = await redis.set(lockName, lockToken, "PX", 30_000, "NX");
    if (acquired !== "OK") {
      throw new QueueStoreError(
        409,
        "IDEMPOTENCY_IN_PROGRESS",
        "A request with this idempotency key is still being processed.",
      );
    }
    const window = Math.floor(
      now().getTime() / (idempotencyRetentionSeconds * 1_000),
    );
    return {
      id: deterministicUuid(`${scope}:${window}`),
      keyName,
      existing: false,
      async commit(id) {
        await redis.set(
          keyName,
          JSON.stringify({ fingerprint, id }),
          "EX",
          idempotencyRetentionSeconds,
        );
      },
      async release() {
        await redis.eval(releaseLockScript, 1, lockName, lockToken);
      },
    };
  }

  async function transitionTask(id, status, eventType, data, result) {
    const record = await readTask(id);
    if (!record) return;
    if (terminalTaskStatuses.has(record.status) && record.status !== status) {
      return;
    }
    if (record.status === status && eventType !== "research.progress") return;
    record.status = status;
    record.updatedAt = timestamp();
    if (result !== undefined)
      record.result = researchResultSchema.parse(result);
    await saveRecord("task", record);
    await eventBroker.publish(id, eventType, data, record.updatedAt);
  }

  async function transitionDocument(id, status) {
    const record = await readDocument(id);
    if (!record || record.status === status) return;
    if (["completed", "failed", "cancelled"].includes(record.status)) return;
    record.status = status;
    record.updatedAt = timestamp();
    await saveRecord("document", record);
  }

  async function handleResearchEvent(type, event) {
    const { jobId } = event;
    try {
      let record = await readTask(jobId);
      if (!record) return;
      if (type === "progress") {
        const buffered = await redis.eval(
          bufferProgressScript,
          2,
          taskKey(jobId),
          pendingProgressKey(jobId),
          JSON.stringify(normalizedProgress(event.data)),
        );
        if (buffered === 1) return;
        record = await readTask(jobId);
      }
      if (!record || record.initializing || record.flushing) return;
      const job = await researchQueue.getJob(jobId);
      if (!job) return;
      const state = await job.getState();
      const exhaustedAttempts =
        state === "failed" && job.attemptsMade >= (job.opts.attempts ?? 1);
      if (type === "waiting" || type === "delayed") {
        await transitionTask(jobId, "queued", "task.queued", {
          status: "queued",
        });
      } else if (type === "active") {
        await transitionTask(jobId, "processing", "task.processing", {
          status: "processing",
        });
      } else if (type === "progress") {
        await transitionTask(
          jobId,
          "processing",
          "research.progress",
          normalizedProgress(event.data),
        );
      } else if (type === "completed") {
        const result = researchResultSchema.parse(job.returnvalue);
        await transitionTask(
          jobId,
          "completed",
          "task.completed",
          { status: "completed" },
          result,
        );
      } else if (type === "failed" && exhaustedAttempts) {
        await transitionTask(jobId, "failed", "task.failed", {
          code: "TASK_EXECUTION_FAILED",
          message: "Research task failed after the configured attempts.",
        });
      } else if (type === "failed") {
        await transitionTask(jobId, "queued", "task.queued", {
          status: "queued",
        });
      }
      logger.info("Queue task event", {
        queue: researchQueueName,
        jobId,
        event: type,
        state:
          type === "completed"
            ? "completed"
            : type === "failed"
              ? exhaustedAttempts
                ? "failed"
                : "queued"
              : type === "active" || type === "progress"
                ? "processing"
                : "queued",
      });
    } catch (error) {
      logger.error("Failed to process research queue event", {
        queue: researchQueueName,
        event: type,
        jobId,
      });
      throw error;
    }
  }

  async function handleDocumentEvent(type, event) {
    const { jobId } = event;
    try {
      const job = await documentQueue.getJob(jobId);
      if (!job) return;
      const state = await job.getState();
      const exhaustedAttempts =
        state === "failed" && job.attemptsMade >= (job.opts.attempts ?? 1);
      if (type === "active") {
        await transitionDocument(jobId, "processing");
      } else if (type === "completed") {
        await transitionDocument(jobId, "completed");
      } else if (type === "failed" && exhaustedAttempts) {
        await transitionDocument(jobId, "failed");
      } else if (type === "failed") {
        await transitionDocument(jobId, "queued");
      }
      logger.info("Queue document event", {
        queue: documentIngestionQueueName,
        jobId,
        event: type,
        state: queueStatus(state),
      });
    } catch (error) {
      logger.error("Failed to process document queue event", {
        queue: documentIngestionQueueName,
        event: type,
        jobId,
      });
      throw error;
    }
  }

  const eventChains = new Map();

  function serializeEventHandling(queueName, handler, type, event, eventId) {
    const chainKey = `${queueName}:${event.jobId}`;
    const seenKey = `evidencegraph:queue-event:${queueName}:${eventId}`;
    const previous = eventChains.get(chainKey) ?? Promise.resolve();
    const current = previous
      .then(async () => {
        const claimed = await redis.set(seenKey, "processing", "EX", 60, "NX");
        if (claimed !== "OK") return;
        try {
          await handler(type, event);
          await redis.set(
            seenKey,
            "done",
            "EX",
            eventDeduplicationRetentionSeconds,
          );
        } catch (error) {
          await redis.del(seenKey);
          throw error;
        }
      })
      .catch(() => {
        logger.error("Failed to forward BullMQ event", {
          queue: queueName,
          jobId: event.jobId,
          event: type,
        });
      });
    eventChains.set(chainKey, current);
    void current.then(() => {
      if (eventChains.get(chainKey) === current) eventChains.delete(chainKey);
    });
  }

  for (const type of [
    "waiting",
    "delayed",
    "active",
    "progress",
    "completed",
    "failed",
  ]) {
    researchEvents.on(type, (event, eventId) =>
      serializeEventHandling(
        researchQueueName,
        handleResearchEvent,
        type,
        event,
        eventId,
      ),
    );
    documentEvents.on(type, (event, eventId) =>
      serializeEventHandling(
        documentIngestionQueueName,
        handleDocumentEvent,
        type,
        event,
        eventId,
      ),
    );
  }
  for (const queueEvents of [researchEvents, documentEvents]) {
    queueEvents.on("error", () => {
      logger.error("BullMQ event connection error");
    });
  }

  async function finalizeTaskSubmission(record, job) {
    if (record.initializing) {
      await eventBroker.publish(
        record.id,
        "task.created",
        { status: "queued" },
        record.createdAt,
      );
      await eventBroker.publish(
        record.id,
        "task.queued",
        { status: "queued" },
        record.createdAt,
      );
      record.initializing = false;
      record.flushing = true;
      await saveRecord("task", record);
    }

    while (true) {
      const pending = await redis.eval(
        drainProgressScript,
        2,
        taskKey(record.id),
        pendingProgressKey(record.id),
      );
      if (pending === "done") break;
      for (const value of pending) {
        const progress = JSON.parse(value);
        record.status = "processing";
        record.updatedAt = timestamp();
        await saveRecord("task", record);
        await eventBroker.publish(
          record.id,
          "research.progress",
          normalizedProgress(progress),
          record.updatedAt,
        );
      }
    }
    record.flushing = false;

    let current = (await readTask(record.id)) ?? record;
    const latestJob = (await researchQueue.getJob(record.id)) ?? job;
    const state = queueStatus(await latestJob.getState());
    if (state !== "queued" && current.status === "queued") {
      await transitionTask(record.id, "processing", "task.processing", {
        status: "processing",
      });
      current = (await readTask(record.id)) ?? current;
    }
    if (state === current.status) return;
    const eventType = {
      completed: "task.completed",
      failed: "task.failed",
    }[state];
    const eventData =
      state === "failed"
        ? {
            code: "TASK_EXECUTION_FAILED",
            message: "Research task failed after the configured attempts.",
          }
        : { status: state };
    const result = state === "completed" ? latestJob.returnvalue : undefined;
    await transitionTask(record.id, state, eventType, eventData, result);
  }

  async function createTask({
    question,
    config,
    owner,
    retryOf,
    queueOptions,
    idempotencyKey,
  }) {
    const parsedConfig = taskConfigSchema.parse(config);
    const parsedQueueOptions = queueOptionsSchema.parse(queueOptions ?? {});
    const fingerprint = sha256(
      JSON.stringify({
        question,
        config: parsedConfig,
        queueOptions: parsedQueueOptions,
      }),
    );
    const reservation = await reserveIdempotency(
      "research",
      owner,
      idempotencyKey,
      fingerprint,
    );
    if (reservation.existing) {
      return getTask(reservation.id, owner);
    }

    let job;
    let createdJob = false;
    let createdResource = false;
    const createdAt = timestamp();
    const record = {
      id: reservation.id,
      question,
      config: parsedConfig,
      status: "queued",
      createdAt,
      updatedAt: createdAt,
      owner,
      fingerprint,
      initializing: true,
      ...(retryOf ? { retryOf } : {}),
      ...(reservation.keyName
        ? { idempotencyKeyName: reservation.keyName }
        : {}),
    };
    try {
      const payload = researchJobSchema.parse({
        taskId: record.id,
        question,
        config: parsedConfig,
        owner,
        fingerprint,
        ...(retryOf ? { retryOf } : {}),
      });
      job = await researchQueue.getJob(record.id);
      if (job) {
        const existingPayload = researchJobSchema.parse(job.data);
        if (
          existingPayload.fingerprint !== fingerprint ||
          existingPayload.owner.userId !== owner.userId ||
          existingPayload.owner.workspaceId !== owner.workspaceId
        ) {
          throw new QueueStoreError(
            409,
            "IDEMPOTENCY_CONFLICT",
            "This idempotency key was already used with a different request.",
          );
        }
        const existingRecord = await readTask(record.id);
        if (existingRecord) {
          if (existingRecord.fingerprint !== fingerprint) {
            throw new QueueStoreError(
              409,
              "IDEMPOTENCY_CONFLICT",
              "This idempotency key was already used with a different request.",
            );
          }
          if (existingRecord.initializing || existingRecord.flushing) {
            await finalizeTaskSubmission(existingRecord, job);
          }
          await reservation.commit?.(record.id);
          return publicTask(await getTask(record.id, owner));
        }

        record.createdAt = new Date(job.timestamp).toISOString();
        record.updatedAt = timestamp();
        record.status = queueStatus(await job.getState());
        record.initializing = true;
        if (record.status === "completed") {
          record.result = researchResultSchema.parse(job.returnvalue);
        }
        await saveRecord("task", record);
        createdResource = true;
        await reservation.commit?.(record.id);
        await finalizeTaskSubmission(record, job);
        return publicTask((await readTask(record.id)) ?? record);
      }

      await saveRecord("task", record);
      createdResource = true;
      job = await researchQueue.add("research", payload, {
        jobId: record.id,
        delay: parsedQueueOptions.delayMs,
        ...(parsedQueueOptions.priority > 0
          ? { priority: parsedQueueOptions.priority }
          : {}),
      });
      createdJob = true;
      await reservation.commit?.(record.id);
      await finalizeTaskSubmission(record, job);
      return publicTask((await readTask(record.id)) ?? record);
    } catch (error) {
      if (createdJob && job) await job.remove().catch(() => {});
      if (createdResource) {
        await deleteRecord("task", record).catch(() => {});
        if (reservation.keyName)
          await redis.del(reservation.keyName).catch(() => {});
      }
      throw error;
    } finally {
      await reservation.release?.();
    }
  }

  async function listTasks(owner) {
    const index = indexKey("task", owner);
    await redis.zremrangebyscore(
      index,
      "-inf",
      Date.now() - taskRetentionSeconds * 1_000,
    );
    const ids = await redis.zrevrange(index, 0, historyLimit - 1);
    const tasks = await Promise.all(
      ids.map(async (id) => {
        try {
          return await getTask(id, owner);
        } catch (error) {
          if (error.code === "TASK_DISPATCH_INTERRUPTED") return null;
          throw error;
        }
      }),
    );
    return tasks.filter(Boolean);
  }

  async function getTask(id, owner) {
    let record = await findTask(id, owner);
    const job = await researchQueue.getJob(id);
    if (!job) {
      if (record.initializing) {
        await deleteRecord("task", record);
        throw new QueueStoreError(
          503,
          "TASK_DISPATCH_INTERRUPTED",
          "Task dispatch was interrupted before the job was enqueued.",
        );
      }
      return publicTask(record);
    }
    if (record.initializing || record.flushing) {
      await finalizeTaskSubmission(record, job);
      record = (await readTask(id)) ?? record;
    }
    const state = queueStatus(await job.getState());
    if (state !== record.status) {
      const eventType = {
        queued: "task.queued",
        processing: "task.processing",
        completed: "task.completed",
        failed: "task.failed",
      }[state];
      const eventData =
        state === "failed"
          ? { code: "TASK_EXECUTION_FAILED", message: "Research task failed." }
          : { status: state };
      const result = state === "completed" ? job.returnvalue : undefined;
      await transitionTask(id, state, eventType, eventData, result);
    }
    return publicTask((await readTask(id)) ?? record);
  }

  async function getTaskStatus(id, owner) {
    const task = await getTask(id, owner);
    return { id: task.id, status: task.status, updatedAt: task.updatedAt };
  }

  async function getTaskResult(id, owner) {
    const task = await getTask(id, owner);
    if (task.status !== "completed" || !task.result) {
      throw new QueueStoreError(
        409,
        "RESULT_NOT_AVAILABLE",
        "The task has no completed result.",
      );
    }
    return task.result;
  }

  async function cancelTask(id, owner) {
    const record = await findTask(id, owner);
    if (terminalTaskStatuses.has(record.status)) {
      throw new QueueStoreError(
        409,
        "TASK_NOT_CANCELLABLE",
        "Only queued tasks can be cancelled before Phase 3 adds cooperative worker cancellation.",
      );
    }
    const job = await researchQueue.getJob(id);
    if (!job) {
      throw new QueueStoreError(404, "NOT_FOUND", "Research task not found.");
    }
    const state = await job.getState();
    if (state === "active") {
      throw new QueueStoreError(
        409,
        "ACTIVE_CANCELLATION_UNSUPPORTED",
        "Active tasks cannot be safely cancelled until worker checkpoints are available.",
      );
    }
    if (!["waiting", "delayed", "paused", "waiting-children"].includes(state)) {
      throw new QueueStoreError(
        409,
        "TASK_NOT_CANCELLABLE",
        "Only queued tasks can be cancelled.",
      );
    }
    await job.remove();
    record.status = "cancelled";
    record.updatedAt = timestamp();
    await saveRecord("task", record);
    await eventBroker.publish(
      id,
      "task.cancelled",
      { status: "cancelled" },
      record.updatedAt,
    );
    return publicTask(record);
  }

  async function retryTask(id, owner) {
    const record = await findTask(id, owner);
    if (record.status !== "failed") {
      throw new QueueStoreError(
        409,
        "TASK_NOT_RETRYABLE",
        "Only failed tasks can be retried.",
      );
    }
    return createTask({
      question: record.question,
      config: record.config,
      owner,
      retryOf: record.id,
      queueOptions: {},
    });
  }

  async function getEvents(id, owner) {
    await getTask(id, owner);
    return eventBroker;
  }

  async function isTaskTerminal(id) {
    const record = await readTask(id);
    return !record || terminalTaskStatuses.has(record.status);
  }

  async function createDocument({
    filename,
    mediaType,
    size,
    bytes,
    owner,
    idempotencyKey,
  }) {
    const fingerprint = sha256(
      JSON.stringify({ filename, mediaType, size, digest: sha256(bytes) }),
    );
    const reservation = await reserveIdempotency(
      "document",
      owner,
      idempotencyKey,
      fingerprint,
    );
    if (reservation.existing) return getDocument(reservation.id, owner);

    const id = reservation.id;
    const objectKey = `documents/${id}`;
    const createdAt = timestamp();
    let job;
    let createdJob = false;
    let createdResource = false;
    let objectCreated = false;
    const record = {
      id,
      filename,
      mediaType,
      size,
      status: "queued",
      createdAt,
      updatedAt: createdAt,
      objectKey,
      owner,
      fingerprint,
      ...(reservation.keyName
        ? { idempotencyKeyName: reservation.keyName }
        : {}),
    };
    try {
      const payload = documentJobSchema.parse({
        documentId: id,
        filename,
        mediaType,
        size,
        objectKey,
        owner,
        fingerprint,
      });
      job = await documentQueue.getJob(id);
      if (job) {
        const existingPayload = documentJobSchema.parse(job.data);
        if (
          existingPayload.fingerprint !== fingerprint ||
          existingPayload.owner.userId !== owner.userId ||
          existingPayload.owner.workspaceId !== owner.workspaceId
        ) {
          throw new QueueStoreError(
            409,
            "IDEMPOTENCY_CONFLICT",
            "This idempotency key was already used with a different upload.",
          );
        }
        const existingRecord = await readDocument(id);
        if (existingRecord) {
          await reservation.commit?.(id);
          return getDocument(id, owner);
        }
        record.createdAt = new Date(job.timestamp).toISOString();
        record.updatedAt = timestamp();
        record.status = queueStatus(await job.getState());
        await saveRecord("document", record);
        createdResource = true;
        await reservation.commit?.(id);
        return publicDocument(record);
      }

      await objectStorage.putObject({ key: objectKey, bytes, mediaType });
      objectCreated = true;
      job = await documentQueue.add("ingest-document", payload, { jobId: id });
      createdJob = true;
      await saveRecord("document", record);
      createdResource = true;
      await reservation.commit?.(id);
      const state = queueStatus(await job.getState());
      if (state !== record.status) await transitionDocument(id, state);
      return publicDocument((await readDocument(id)) ?? record);
    } catch (error) {
      if (createdJob && job) await job.remove().catch(() => {});
      if (createdResource) {
        await deleteRecord("document", record).catch(() => {});
        if (reservation.keyName)
          await redis.del(reservation.keyName).catch(() => {});
      }
      if (objectCreated) {
        await objectStorage.deleteObject(objectKey).catch(() => {});
      }
      throw error;
    } finally {
      await reservation.release?.();
    }
  }

  async function listDocuments(owner) {
    const ids = await redis.zrevrange(
      indexKey("document", owner),
      0,
      historyLimit - 1,
    );
    return Promise.all(ids.map((id) => getDocument(id, owner)));
  }

  async function getDocument(id, owner) {
    const record = await findDocument(id, owner);
    const job = await documentQueue.getJob(id);
    if (!job) return publicDocument(record);
    const state = queueStatus(await job.getState());
    if (state !== record.status) {
      await transitionDocument(id, state);
      record.status = state;
    }
    return publicDocument(record);
  }

  async function getDocumentContent(id, owner) {
    const record = await findDocument(id, owner);
    const content = await objectStorage.getObject(record.objectKey);
    return { filename: record.filename, ...content };
  }

  async function deleteDocument(id, owner) {
    const record = await findDocument(id, owner);
    const job = await documentQueue.getJob(id);
    if (job) {
      const state = await job.getState();
      if (state === "active") {
        throw new QueueStoreError(
          409,
          "DOCUMENT_INGESTION_ACTIVE",
          "An active document-ingestion job cannot be deleted.",
        );
      }
      await job.remove();
    }
    await objectStorage.deleteObject(record.objectKey);
    await deleteRecord("document", record);
  }

  async function checkReadiness() {
    const results = await Promise.allSettled([
      runtime.checkHealth(),
      objectStorage.checkHealth(),
    ]);
    const dependencies = {
      valkey: results[0].status === "fulfilled" ? "ready" : "unavailable",
      minio: results[1].status === "fulfilled" ? "ready" : "unavailable",
    };
    return {
      status: Object.values(dependencies).every((status) => status === "ready")
        ? "ready"
        : "not-ready",
      dependencies,
    };
  }

  async function close() {
    try {
      await runtime.close();
    } finally {
      objectStorage.close();
    }
  }

  return {
    cancelTask,
    checkReadiness,
    close,
    createDocument,
    createTask,
    deleteDocument,
    eventBroker,
    getDocument,
    getDocumentContent,
    getEvents,
    getQueueCounts: runtime.getCounts,
    getTask,
    getTaskResult,
    getTaskStatus,
    initialize: runtime.initialize,
    isTaskTerminal,
    listDocuments,
    listTasks,
    retryTask,
  };
}
