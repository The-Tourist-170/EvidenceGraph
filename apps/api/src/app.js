import { z } from "zod";
import { logger } from "@evidencegraph/shared";
import {
  createResearchTaskSchema,
  documentSchema,
  documentStatusSchema,
  errorEnvelopeSchema,
  researchResultSchema,
  researchTaskSchema,
  successEnvelopeSchema,
  taskStatusResponseSchema,
} from "./contracts.js";
import { ApiError, createMemoryStore } from "./memory-store.js";
import { createEventStreamResponse } from "./event-broker.js";

const apiBase = "/api/v1";
const maxJsonBytes = 1_048_576;
const maxUploadBytes = 5_242_880;
const maxMultipartBytes = maxUploadBytes + 65_536;
const identitySchema = z
  .object({
    userId: z.string().min(1),
    workspaceId: z.string().min(1),
  })
  .strict();

const allowedMediaTypes = new Map([
  [".pdf", new Set(["application/pdf"])],
  [".txt", new Set(["text/plain"])],
  [".md", new Set(["text/markdown", "text/plain", "text/x-markdown"])],
]);

function localIdentity(_request, env) {
  if (env.NODE_ENV === "production") {
    throw new ApiError(
      503,
      "AUTH_NOT_CONFIGURED",
      "Authentication is not configured for protected API routes.",
    );
  }
  return { userId: "local-user", workspaceId: "local-workspace" };
}

function errorResponse(error) {
  const apiError =
    error instanceof ApiError ||
    (Number.isInteger(error?.status) && typeof error?.code === "string")
      ? error
      : new ApiError(500, "INTERNAL_ERROR", "An unexpected error occurred.");
  const payload = errorEnvelopeSchema.parse({
    error: {
      code: apiError.code,
      message: apiError.message,
      ...(apiError.details === undefined ? {} : { details: apiError.details }),
    },
  });
  return Response.json(payload, { status: apiError.status });
}

function jsonResponse(dataSchema, data, status = 200, headers = {}) {
  const payload = successEnvelopeSchema(dataSchema).parse({ data });
  return Response.json(payload, { status, headers });
}

async function readLimitedBody(request, limit) {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    throw new ApiError(
      413,
      "PAYLOAD_TOO_LARGE",
      "Request body exceeds the allowed size.",
    );
  }

  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > limit) {
        await reader.cancel();
        throw new ApiError(
          413,
          "PAYLOAD_TOO_LARGE",
          "Request body exceeds the allowed size.",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function readJson(request, schema) {
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  ) {
    throw new ApiError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "Content-Type must be application/json.",
    );
  }

  const bytes = await readLimitedBody(request, maxJsonBytes);
  let body;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ApiError(
      400,
      "INVALID_JSON",
      "Request body must contain valid JSON.",
    );
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "Request validation failed.",
      parsed.error.issues,
    );
  }
  return parsed.data;
}

function decodePathSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new ApiError(
      400,
      "INVALID_PATH_PARAMETER",
      "Path parameter is malformed.",
    );
  }
}

function taskIdFromPath(value) {
  const result = z.string().uuid().safeParse(value);
  if (!result.success)
    throw new ApiError(404, "NOT_FOUND", "Resource not found.");
  return result.data;
}

function parseLastEventId(value) {
  if (value === null) return null;
  if (!/^\d+$/.test(value)) {
    throw new ApiError(
      400,
      "INVALID_LAST_EVENT_ID",
      "Last-Event-ID must be a non-negative integer.",
    );
  }
  const id = Number(value);
  if (!Number.isSafeInteger(id)) {
    throw new ApiError(
      400,
      "INVALID_LAST_EVENT_ID",
      "Last-Event-ID is outside the supported range.",
    );
  }
  return id;
}

function safeFilename(filename) {
  const basename = filename.replaceAll("\\", "/").split("/").at(-1) ?? "";
  const normalized = basename
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 128);
  if (!normalized || normalized === "." || normalized === "..") {
    throw new ApiError(
      400,
      "INVALID_FILENAME",
      "The uploaded filename is invalid.",
    );
  }
  return normalized;
}

async function readUploadedFile(request) {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("multipart/form-data;")) {
    throw new ApiError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "Upload must use multipart/form-data.",
    );
  }
  const body = await readLimitedBody(request, maxMultipartBytes);
  let formData;
  try {
    formData = await new Request(request.url, {
      method: "POST",
      headers: request.headers,
      body,
    }).formData();
  } catch {
    throw new ApiError(
      400,
      "INVALID_MULTIPART",
      "Upload form data is malformed.",
    );
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    throw new ApiError(
      400,
      "FILE_REQUIRED",
      "Upload must include a file field.",
    );
  }
  if (file.size === 0) {
    throw new ApiError(400, "EMPTY_FILE", "Uploaded files must not be empty.");
  }
  if (file.size > maxUploadBytes) {
    throw new ApiError(
      413,
      "FILE_TOO_LARGE",
      "Uploaded file exceeds the 5 MiB limit.",
    );
  }

  const filename = safeFilename(file.name);
  const extension = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  const mediaType = file.type.toLowerCase().split(";")[0].trim();
  const acceptedTypes = allowedMediaTypes.get(extension);
  if (!acceptedTypes?.has(mediaType)) {
    throw new ApiError(
      415,
      "UNSUPPORTED_FILE_TYPE",
      "Only PDF, plain-text, and Markdown files are accepted.",
    );
  }

  return {
    filename,
    mediaType,
    size: file.size,
    bytes: new Uint8Array(await file.arrayBuffer()),
  };
}

function createRateLimiter({ maxRequests, windowMs, now }) {
  const windows = new Map();
  return function check(identity) {
    const key = `${identity.userId}\u0000${identity.workspaceId}`;
    const currentTime = now();
    let window = windows.get(key);
    if (!window || currentTime >= window.expiresAt) {
      window = { count: 0, expiresAt: currentTime + windowMs };
      windows.set(key, window);
    }
    window.count += 1;
    if (window.count > maxRequests) {
      throw new ApiError(429, "RATE_LIMITED", "Request rate limit exceeded.", {
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((window.expiresAt - currentTime) / 1_000),
        ),
      });
    }
  };
}

export function createApiHandler({
  env = process.env,
  authenticate = localIdentity,
  store = createMemoryStore(),
  now = Date.now,
  rateLimit = 120,
  rateLimitWindowMs = 60_000,
  heartbeatIntervalMs = 15_000,
} = {}) {
  const checkRateLimit = createRateLimiter({
    maxRequests: rateLimit,
    windowMs: rateLimitWindowMs,
    now,
  });

  async function dispatch(request, url) {
    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse(z.object({ status: z.literal("ok") }).strict(), {
        status: "ok",
      });
    }
    if (request.method === "GET" && url.pathname === "/ready") {
      if (!store.checkReadiness) {
        return errorResponse(
          new ApiError(503, "NOT_READY", "API dependencies are not ready."),
        );
      }
      const readiness = await store.checkReadiness();
      const readinessSchema = z
        .object({
          status: z.enum(["ready", "not-ready"]),
          dependencies: z
            .object({
              valkey: z.enum(["ready", "unavailable"]),
              minio: z.enum(["ready", "unavailable"]),
              postgres: z.enum(["ready", "unavailable"]).optional(),
              qdrant: z.enum(["ready", "unavailable"]).optional(),
              neo4j: z.enum(["ready", "unavailable"]).optional(),
            })
            .strict(),
        })
        .strict();
      return jsonResponse(
        readinessSchema,
        readiness,
        readiness.status === "ready" ? 200 : 503,
      );
    }
    if (!url.pathname.startsWith(`${apiBase}/`)) {
      throw new ApiError(404, "NOT_FOUND", "Route not found.");
    }

    const identityResult = identitySchema.safeParse(
      await authenticate(request, env),
    );
    if (!identityResult.success) {
      throw new ApiError(401, "UNAUTHENTICATED", "Authentication is required.");
    }
    const identity = identityResult.data;
    checkRateLimit(identity);

    const tasksPath = `${apiBase}/research-tasks`;
    if (url.pathname === tasksPath && request.method === "POST") {
      const input = await readJson(request, createResearchTaskSchema);
      const task = await store.createTask({
        ...input,
        owner: identity,
        idempotencyKey: request.headers.get("idempotency-key") ?? undefined,
      });
      return jsonResponse(researchTaskSchema, task, 202);
    }
    if (url.pathname === tasksPath && request.method === "GET") {
      return jsonResponse(
        z.array(researchTaskSchema),
        await store.listTasks(identity),
      );
    }

    const taskMatch = url.pathname.match(
      /^\/api\/v1\/research-tasks\/([^/]+)(?:\/(status|result|events|cancel|retry))?$/,
    );
    if (taskMatch) {
      const id = taskIdFromPath(decodePathSegment(taskMatch[1]));
      const action = taskMatch[2];
      if (!action && request.method === "GET") {
        return jsonResponse(
          researchTaskSchema,
          await store.getTask(id, identity),
        );
      }
      if (action === "status" && request.method === "GET") {
        return jsonResponse(
          taskStatusResponseSchema,
          await store.getTaskStatus(id, identity),
        );
      }
      if (action === "result" && request.method === "GET") {
        return jsonResponse(
          researchResultSchema,
          await store.getTaskResult(id, identity),
        );
      }
      if (action === "cancel" && request.method === "POST") {
        const task = await store.cancelTask(id, identity);
        return jsonResponse(
          researchTaskSchema,
          task,
          task.cancellationRequested ? 202 : 200,
        );
      }
      if (action === "retry" && request.method === "POST") {
        return jsonResponse(
          researchTaskSchema,
          await store.retryTask(id, identity),
          202,
        );
      }
      if (action === "events" && request.method === "GET") {
        const broker = await store.getEvents(id, identity);
        if (broker.createStreamResponse) {
          return broker.createStreamResponse({
            taskId: id,
            afterId: parseLastEventId(request.headers.get("last-event-id")),
            isTerminal: () => store.isTaskTerminal(id),
            heartbeatIntervalMs,
            signal: request.signal,
          });
        }
        if ((await broker.subscriberCount(id)) >= broker.maxSubscribers) {
          throw new ApiError(
            429,
            "TOO_MANY_EVENT_SUBSCRIBERS",
            "Too many event subscribers for this task.",
          );
        }
        return createEventStreamResponse({
          taskId: id,
          broker,
          afterId: parseLastEventId(request.headers.get("last-event-id")),
          isTerminal: () => store.isTaskTerminal(id),
          heartbeatIntervalMs,
          signal: request.signal,
        });
      }
      throw new ApiError(
        405,
        "METHOD_NOT_ALLOWED",
        "Method is not allowed for this route.",
      );
    }

    const documentsPath = `${apiBase}/documents`;
    if (url.pathname === documentsPath && request.method === "POST") {
      const upload = await readUploadedFile(request);
      const document = await store.createDocument({
        ...upload,
        owner: identity,
        idempotencyKey: request.headers.get("idempotency-key") ?? undefined,
      });
      return jsonResponse(documentSchema, document, 201);
    }
    if (url.pathname === documentsPath && request.method === "GET") {
      return jsonResponse(
        z.array(documentSchema),
        await store.listDocuments(identity),
      );
    }

    const documentMatch = url.pathname.match(
      /^\/api\/v1\/documents\/([^/]+)(?:\/(status|content))?$/,
    );
    if (documentMatch) {
      const id = taskIdFromPath(decodePathSegment(documentMatch[1]));
      const action = documentMatch[2];
      if (!action && request.method === "GET") {
        return jsonResponse(
          documentSchema,
          await store.getDocument(id, identity),
        );
      }
      if (action === "status" && request.method === "GET") {
        const document = await store.getDocument(id, identity);
        return jsonResponse(
          z
            .object({ id: z.string().uuid(), status: documentStatusSchema })
            .strict(),
          { id: document.id, status: document.status },
        );
      }
      if (action === "content" && request.method === "GET") {
        const content = await store.getDocumentContent(id, identity);
        return new Response(content.bytes, {
          headers: {
            "Content-Disposition": `attachment; filename="${content.filename}"`,
            "Content-Type": content.mediaType,
            "X-Content-Type-Options": "nosniff",
          },
        });
      }
      if (!action && request.method === "DELETE") {
        await store.deleteDocument(id, identity);
        return jsonResponse(
          z.object({ id: z.string().uuid(), deleted: z.literal(true) }),
          {
            id,
            deleted: true,
          },
        );
      }
      throw new ApiError(
        405,
        "METHOD_NOT_ALLOWED",
        "Method is not allowed for this route.",
      );
    }

    throw new ApiError(404, "NOT_FOUND", "Route not found.");
  }

  return async function handleRequest(request) {
    const url = new URL(request.url);
    const startedAt = now();
    let response;
    try {
      response = await dispatch(request, url);
    } catch (error) {
      if (
        !(error instanceof ApiError) &&
        !(Number.isInteger(error?.status) && typeof error?.code === "string")
      ) {
        logger.error("Unhandled API error", {
          method: request.method,
          path: url.pathname,
        });
      }
      response = errorResponse(error);
    }
    logger.info("API request", {
      method: request.method,
      path: url.pathname,
      status: response.status,
      durationMs: Math.max(0, now() - startedAt),
    });
    return response;
  };
}
