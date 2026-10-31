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
    executionId: z.string().uuid().optional(),
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
if redis.call('EXISTS', KEYS[1]) == 1 or redis.call('EXISTS', KEYS[2]) == 1 then
  redis.call('RPUSH', KEYS[3], ARGV[1])
  redis.call('EXPIRE', KEYS[3], ARGV[2])
  return 1
end
return 0
`;
const drainProgressScript = `
if redis.call('LLEN', KEYS[2]) == 0 then
  redis.call('DEL', KEYS[1])
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
  const stage =
    typeof progress?.stage === "string" && progress.stage.length > 0
      ? progress.stage.slice(0, 80)
      : undefined;
  const executionId =
    typeof progress?.executionId === "string"
      ? progress.executionId
      : undefined;
  return {
    percent,
    message,
    ...(stage ? { stage } : {}),
    ...(executionId ? { executionId } : {}),
  };
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
    cancellationRequested: fields.cancellationRequested === "1",
    ...(fields.executionId ? { executionId: fields.executionId } : {}),
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
    ...(record.executionId ? { executionId: record.executionId } : {}),
    ...(record.cancellationRequested ? { cancellationRequested: true } : {}),
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
  repository,
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

  async function publishTaskEvent(taskId, type, data, createdAt) {
    const event = await eventBroker.publish(taskId, type, data, createdAt);
    if (repository?.appendTaskEvent) await repository.appendTaskEvent(event);
    return event;
  }

  function taskKey(id) {
    return `evidencegraph:task:${id}`;
  }

  function pendingProgressKey(id) {
    return `evidencegraph:pending-progress:${id}`;
  }

  function cancellationKey(id) {
    return `evidencegraph:task-cancellation:${id}`;
  }

  function initializingKey(id) {
    return `evidencegraph:task-initializing:${id}`;
  }

  function flushingKey(id) {
    return `evidencegraph:task-flushing:${id}`;
  }

  async function markTaskInitializing(id) {
    await redis
      .multi()
      .set(initializingKey(id), "1", "EX", taskRetentionSeconds)
      .del(flushingKey(id))
      .exec();
  }

  async function beginTaskFlush(id) {
    await redis
      .multi()
      .set(flushingKey(id), "1", "EX", taskRetentionSeconds)
      .del(initializingKey(id))
      .exec();
  }

  async function setTaskFlags(id, initializing, flushing) {
    if (repository?.setTaskFlags) {
      await repository.setTaskFlags(id, { initializing, flushing });
      return;
    }
    const transaction = redis.multi();
    transaction.hset(taskKey(id), {
      initializing: initializing ? "1" : "0",
      flushing: flushing ? "1" : "0",
    });
    transaction.expire(taskKey(id), taskRetentionSeconds);
    await transaction.exec();
  }

  function documentKey(id) {
    return `evidencegraph:document:${id}`;
  }

  function timestamp() {
    return now().toISOString();
  }

  async function readTask(id) {
    if (repository) return repository.getTask(id);
    return parseTask(await redis.hgetall(taskKey(id)));
  }

  async function readDocument(id) {
    if (repository) return repository.getDocument(id);
    return parseDocument(await redis.hgetall(documentKey(id)));
  }

  async function saveRecord(kind, record) {
    if (repository) {
      return kind === "task"
        ? repository.saveTask(record)
        : repository.saveDocument(record);
    }
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
            cancellationRequested: record.cancellationRequested ? "1" : "0",
            executionId: record.executionId ?? "",
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
    if (repository) {
      return kind === "task"
        ? repository.deleteTask(record)
        : repository.deleteDocument(record);
    }
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
    const window = Math.floor(
      now().getTime() / (idempotencyRetentionSeconds * 1_000),
    );
    const resourceId = deterministicUuid(`${scope}:${window}`);
    if (repository?.reserveIdempotency) {
      return repository.reserveIdempotency({
        kind,
        owner,
        keyName,
        fingerprint,
        id: resourceId,
        retentionSeconds: idempotencyRetentionSeconds,
      });
    }
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
    return {
      id: resourceId,
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

  async function transitionTask(
    id,
    status,
    eventType,
    data,
    result,
    executionId,
  ) {
    const record = await readTask(id);
    if (!record) return;
    if (terminalTaskStatuses.has(record.status) && record.status !== status) {
      return;
    }
    if (record.status === status && eventType !== "research.progress") return;
    record.status = status;
    record.updatedAt = timestamp();
    if (status === "completed") record.cancellationRequested = false;
    if (result !== undefined) {
      record.result = researchResultSchema.parse(result);
      if (record.result.executionId)
        record.executionId = record.result.executionId;
    }
    if (executionId) record.executionId = executionId;
    await saveRecord("task", record);
    await publishTaskEvent(id, eventType, data, record.updatedAt);
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
          3,
          initializingKey(jobId),
          flushingKey(jobId),
          pendingProgressKey(jobId),
          JSON.stringify(normalizedProgress(event.data)),
          taskRetentionSeconds,
        );
        if (buffered === 1) return;
        record = await readTask(jobId);
      }
      if (
        !record ||
        (type !== "progress" && (record.initializing || record.flushing))
      )
        return;
      const job = await researchQueue.getJob(jobId);
      if (!job) return;
      const state = await job.getState();
      const exhaustedAttempts =
        state === "failed" &&
        (job.attemptsMade >= (job.opts.attempts ?? 1) ||
          job.failedReason?.includes("TASK_TIMED_OUT"));
      const cancellationRequested =
        type === "failed" && (await redis.exists(cancellationKey(jobId))) === 1;
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
          undefined,
          event.data?.executionId,
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
        await redis.del(cancellationKey(jobId));
      } else if (type === "failed" && cancellationRequested) {
        await transitionTask(jobId, "cancelled", "task.cancelled", {
          status: "cancelled",
        });
        await redis.del(cancellationKey(jobId));
      } else if (type === "failed" && exhaustedAttempts) {
        const timedOut = job.failedReason?.includes("TASK_TIMED_OUT");
        await transitionTask(jobId, "failed", "task.failed", {
          code: timedOut ? "TASK_EXECUTION_TIMED_OUT" : "TASK_EXECUTION_FAILED",
          message: timedOut
            ? "Research task exceeded its configured execution limit."
            : "Research task failed after the configured attempts.",
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
        state === "failed" &&
        (job.attemptsMade >= (job.opts.attempts ?? 1) ||
          job.failedReason?.includes("DOCUMENT_SIZE_MISMATCH") ||
          job.failedReason?.includes("TASK_TIMED_OUT"));
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
      await markTaskInitializing(record.id);
      await publishTaskEvent(
        record.id,
        "task.created",
        { status: "queued" },
        record.createdAt,
      );
      await publishTaskEvent(
        record.id,
        "task.queued",
        { status: "queued" },
        record.createdAt,
      );
      record.initializing = false;
      record.flushing = true;
      await saveRecord("task", record);
      await beginTaskFlush(record.id);
    } else if (record.flushing) {
      await redis.set(flushingKey(record.id), "1", "EX", taskRetentionSeconds);
    }

    while (true) {
      const pending = await redis.eval(
        drainProgressScript,
        2,
        flushingKey(record.id),
        pendingProgressKey(record.id),
      );
      if (pending === "done") break;
      for (const value of pending) {
        const progress = normalizedProgress(JSON.parse(value));
        await transitionTask(
          record.id,
          "processing",
          "research.progress",
          progress,
          undefined,
          progress.executionId,
        );
      }
    }
    await setTaskFlags(record.id, false, false);

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
    const timedOut = latestJob.failedReason?.includes("TASK_TIMED_OUT");
    const eventData =
      state === "failed"
        ? {
            code: timedOut
              ? "TASK_EXECUTION_TIMED_OUT"
              : "TASK_EXECUTION_FAILED",
            message: timedOut
              ? "Research task exceeded its configured execution limit."
              : "Research task failed after the configured attempts.",
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
          if (existingRecord.initializing) {
            await markTaskInitializing(record.id);
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
      await markTaskInitializing(record.id);
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
        await redis
          .del(
            initializingKey(record.id),
            flushingKey(record.id),
            pendingProgressKey(record.id),
          )
          .catch(() => {});
        if (reservation.keyName)
          await redis.del(reservation.keyName).catch(() => {});
      }
      throw error;
    } finally {
      await reservation.release?.();
    }
  }

  async function listTasks(owner) {
    if (repository) {
      const records = await repository.listTasks(owner, historyLimit);
      return Promise.all(records.map((record) => getTask(record.id, owner)));
    }
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
    if (record.initializing) await markTaskInitializing(id);
    if (record.initializing || record.flushing) {
      await finalizeTaskSubmission(record, job);
      record = (await readTask(id)) ?? record;
    }
    const state = queueStatus(await job.getState());
    if (state === "failed" && (await redis.exists(cancellationKey(id))) === 1) {
      await transitionTask(id, "cancelled", "task.cancelled", {
        status: "cancelled",
      });
      await redis.del(cancellationKey(id));
      return publicTask((await readTask(id)) ?? record);
    }
    if (state !== record.status) {
      const eventType = {
        queued: "task.queued",
        processing: "task.processing",
        completed: "task.completed",
        failed: "task.failed",
      }[state];
      const timedOut = job.failedReason?.includes("TASK_TIMED_OUT");
      const eventData =
        state === "failed"
          ? {
              code: timedOut
                ? "TASK_EXECUTION_TIMED_OUT"
                : "TASK_EXECUTION_FAILED",
              message: timedOut
                ? "Research task exceeded its configured execution limit."
                : "Research task failed.",
            }
          : { status: state };
      const result = state === "completed" ? job.returnvalue : undefined;
      await transitionTask(id, state, eventType, eventData, result);
      if (state === "completed") await redis.del(cancellationKey(id));
    }
    return publicTask((await readTask(id)) ?? record);
  }

  async function getTaskStatus(id, owner) {
    const task = await getTask(id, owner);
    return {
      id: task.id,
      status: task.status,
      updatedAt: task.updatedAt,
      ...(task.cancellationRequested ? { cancellationRequested: true } : {}),
    };
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
      if (record.cancellationRequested) return publicTask(record);
      const cancelMarker = cancellationKey(id);
      await redis.set(cancelMarker, "1", "EX", 900);
      record.cancellationRequested = true;
      record.updatedAt = timestamp();
      await saveRecord("task", record);
      await publishTaskEvent(
        id,
        "task.cancellation_requested",
        { status: "processing", cancellationRequested: true },
        record.updatedAt,
      );
      return publicTask(record);
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
    await publishTaskEvent(
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
    if (repository) {
      const records = await repository.listDocuments(owner, historyLimit);
      return Promise.all(
        records.map((record) => getDocument(record.id, owner)),
      );
    }
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
    if (repository?.deleteDocumentIndexes) {
      await repository.deleteDocumentIndexes({
        documentId: record.id,
        workspaceId: owner.workspaceId,
        userId: owner.userId,
      });
    }
    await objectStorage.deleteObject(record.objectKey);
    await deleteRecord("document", record);
  }

  async function checkReadiness() {
    const checks = await Promise.allSettled([
      runtime.checkHealth(),
      objectStorage.checkHealth(),
    ]);
    const dependencies = {
      valkey: checks[0].status === "fulfilled" ? "ready" : "unavailable",
      minio: checks[1].status === "fulfilled" ? "ready" : "unavailable",
    };
    if (repository?.checkComponents) {
      Object.assign(dependencies, await repository.checkComponents());
    } else if (repository?.checkHealth) {
      const result = await Promise.allSettled([repository.checkHealth()]);
      dependencies.postgres =
        result[0].status === "fulfilled" ? "ready" : "unavailable";
    }
    return {
      status: Object.values(dependencies).every((status) => status === "ready")
        ? "ready"
        : "not-ready",
      dependencies,
    };
  }

  async function initialize() {
    await runtime.initialize();
    if (repository?.initialize)
      await repository.initialize({ legacyRedis: redis });
  }

  async function close() {
    let failure;
    try {
      await runtime.close();
    } catch (error) {
      failure = error;
    }
    try {
      objectStorage.close();
    } catch (error) {
      failure ??= error;
    }
    if (repository?.close) {
      try {
        await repository.close();
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) throw failure;
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
    initialize,
    isTaskTerminal,
    listDocuments,
    listTasks,
    retryTask,
  };
}
