import { researchTaskSchema } from "./contracts.js";
import { createEventBroker } from "./event-broker.js";

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const terminalStatuses = new Set(["completed", "failed", "cancelled"]);

function sameOwner(left, right) {
  return left.userId === right.userId && left.workspaceId === right.workspaceId;
}

function publicTask(task) {
  const result = { ...task };
  delete result.userId;
  delete result.workspaceId;
  return researchTaskSchema.parse(result);
}

function defaultExecutor(task, controls) {
  controls.schedule(() => {
    controls.processing();
    controls.schedule(() => {
      controls.progress(50, "The simulator is gathering placeholder evidence.");
      controls.schedule(() => {
        controls.complete({
          summary: `Synthetic research completed for: ${task.question}`,
          claims: [],
          sourceIds: [],
          synthetic: true,
        });
      }, 50);
    }, 50);
  }, 50);
}

export function createMemoryStore({
  now = () => new Date(),
  schedule = setTimeout,
  cancelSchedule = clearTimeout,
  executor = defaultExecutor,
  maxTasks = 1_000,
  maxDocuments = 1_000,
  maxDocumentBytesTotal = 25_000_000,
  maxEventHistory = 100,
  maxEventSubscribers = 32,
} = {}) {
  const tasks = new Map();
  const documents = new Map();
  let totalDocumentBytes = 0;
  const scheduledByTask = new Map();
  const eventBroker = createEventBroker({
    maxHistory: maxEventHistory,
    maxSubscribers: maxEventSubscribers,
  });

  function timestamp() {
    return now().toISOString();
  }

  function publish(taskId, type, data) {
    return eventBroker.publish(taskId, type, data, timestamp());
  }

  function scheduleTask(taskId, callback, delayMs) {
    const taskTimers = scheduledByTask.get(taskId) ?? new Set();
    const timer = schedule(() => {
      taskTimers.delete(timer);
      if (taskTimers.size === 0) scheduledByTask.delete(taskId);
      callback();
    }, delayMs);
    taskTimers.add(timer);
    scheduledByTask.set(taskId, taskTimers);
  }

  function clearTaskSchedules(taskId) {
    for (const timer of scheduledByTask.get(taskId) ?? []) {
      cancelSchedule(timer);
    }
    scheduledByTask.delete(taskId);
  }

  function updateTask(taskId, update) {
    const task = tasks.get(taskId);
    if (!task || terminalStatuses.has(task.status)) return null;
    Object.assign(task, update, { updatedAt: timestamp() });
    return task;
  }

  function startExecutor(task) {
    const controls = {
      schedule: (callback, delayMs = 0) =>
        scheduleTask(task.id, callback, delayMs),
      processing() {
        const updatedTask = updateTask(task.id, { status: "processing" });
        if (updatedTask)
          publish(task.id, "task.processing", { status: updatedTask.status });
      },
      progress(percent, message) {
        const updatedTask = updateTask(task.id, { status: "processing" });
        if (updatedTask)
          publish(task.id, "research.progress", { percent, message });
      },
      complete(result) {
        const updatedTask = updateTask(task.id, {
          status: "completed",
          result,
        });
        if (!updatedTask) return;
        clearTaskSchedules(task.id);
        publish(task.id, "task.completed", { status: updatedTask.status });
      },
      fail() {
        const updatedTask = updateTask(task.id, { status: "failed" });
        if (!updatedTask) return;
        clearTaskSchedules(task.id);
        publish(task.id, "task.failed", {
          code: "TASK_EXECUTION_FAILED",
          message: "Simulated task execution failed.",
        });
      },
    };

    try {
      executor(publicTask(task), controls);
    } catch {
      controls.fail();
    }
  }

  function createTask({ question, config, owner, retryOf }) {
    if (tasks.size >= maxTasks) {
      throw new ApiError(
        503,
        "TASK_CAPACITY_REACHED",
        "The in-memory task capacity is full.",
      );
    }

    const createdAt = timestamp();
    const task = {
      id: crypto.randomUUID(),
      question,
      config,
      status: "queued",
      createdAt,
      updatedAt: createdAt,
      ...owner,
      ...(retryOf ? { retryOf } : {}),
    };
    tasks.set(task.id, task);
    publish(task.id, "task.created", { status: task.status });
    publish(task.id, "task.queued", { status: task.status });
    startExecutor(task);
    return publicTask(task);
  }

  function findOwnedTask(id, owner) {
    const task = tasks.get(id);
    if (!task || !sameOwner(task, owner)) {
      throw new ApiError(404, "NOT_FOUND", "Research task not found.");
    }
    return task;
  }

  function listTasks(owner) {
    return [...tasks.values()]
      .filter((task) => sameOwner(task, owner))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(publicTask);
  }

  function getTask(id, owner) {
    return publicTask(findOwnedTask(id, owner));
  }

  function getTaskStatus(id, owner) {
    const task = findOwnedTask(id, owner);
    return {
      id: task.id,
      status: task.status,
      updatedAt: task.updatedAt,
    };
  }

  function getTaskResult(id, owner) {
    const task = findOwnedTask(id, owner);
    if (task.status !== "completed" || !task.result) {
      throw new ApiError(
        409,
        "RESULT_NOT_AVAILABLE",
        "The task has no completed result.",
      );
    }
    return task.result;
  }

  function cancelTask(id, owner) {
    const task = findOwnedTask(id, owner);
    if (terminalStatuses.has(task.status)) {
      throw new ApiError(
        409,
        "TASK_NOT_CANCELLABLE",
        "Only queued or processing tasks can be cancelled.",
      );
    }
    clearTaskSchedules(id);
    task.status = "cancelled";
    task.updatedAt = timestamp();
    publish(id, "task.cancelled", { status: task.status });
    return publicTask(task);
  }

  function retryTask(id, owner) {
    const task = findOwnedTask(id, owner);
    if (task.status !== "failed") {
      throw new ApiError(
        409,
        "TASK_NOT_RETRYABLE",
        "Only failed tasks can be retried.",
      );
    }
    return createTask({
      question: task.question,
      config: task.config,
      owner,
      retryOf: task.id,
    });
  }

  function getEvents(id, owner) {
    findOwnedTask(id, owner);
    return eventBroker;
  }

  function isTaskTerminal(id) {
    const task = tasks.get(id);
    return !task || terminalStatuses.has(task.status);
  }

  function createDocument({ filename, mediaType, size, bytes, owner }) {
    if (
      documents.size >= maxDocuments ||
      totalDocumentBytes + size > maxDocumentBytesTotal
    ) {
      throw new ApiError(
        503,
        "DOCUMENT_CAPACITY_REACHED",
        "The in-memory document capacity is full.",
      );
    }
    const document = {
      id: crypto.randomUUID(),
      filename,
      mediaType,
      size,
      status: "uploaded",
      createdAt: timestamp(),
      bytes,
      ...owner,
    };
    documents.set(document.id, document);
    totalDocumentBytes += size;
    return publicDocument(document);
  }

  function publicDocument(document) {
    const metadata = { ...document };
    delete metadata.bytes;
    delete metadata.userId;
    delete metadata.workspaceId;
    return metadata;
  }

  function findOwnedDocument(id, owner) {
    const document = documents.get(id);
    if (!document || !sameOwner(document, owner)) {
      throw new ApiError(404, "NOT_FOUND", "Document not found.");
    }
    return document;
  }

  function listDocuments(owner) {
    return [...documents.values()]
      .filter((document) => sameOwner(document, owner))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(publicDocument);
  }

  function getDocument(id, owner) {
    return publicDocument(findOwnedDocument(id, owner));
  }

  function getDocumentContent(id, owner) {
    const document = findOwnedDocument(id, owner);
    return {
      filename: document.filename,
      mediaType: document.mediaType,
      bytes: document.bytes,
    };
  }

  function deleteDocument(id, owner) {
    const document = findOwnedDocument(id, owner);
    documents.delete(id);
    totalDocumentBytes -= document.size;
  }

  return {
    cancelTask,
    createDocument,
    createTask,
    deleteDocument,
    eventBroker,
    getDocument,
    getDocumentContent,
    getEvents,
    getTask,
    getTaskResult,
    getTaskStatus,
    isTaskTerminal,
    listDocuments,
    listTasks,
    retryTask,
  };
}
