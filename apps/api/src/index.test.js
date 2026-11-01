import { describe, expect, test } from "bun:test";
import { createApiHandler } from "./app.js";
import { createMemoryStore } from "./memory-store.js";

const taskPath = "/api/v1/research-tasks";
const documentPath = "/api/v1/documents";

function createHarness({ executor, storeOptions = {}, apiOptions = {} } = {}) {
  const scheduled = [];
  const schedule = (callback, delayMs) => {
    const timer = { callback, delayMs, cancelled: false };
    scheduled.push(timer);
    return timer;
  };
  const store = createMemoryStore({
    schedule,
    cancelSchedule: (timer) => {
      timer.cancelled = true;
    },
    executor,
    ...storeOptions,
  });
  const handleRequest = createApiHandler({
    env: { NODE_ENV: "test" },
    store,
    ...apiOptions,
  });

  return {
    handleRequest,
    store,
    runScheduled() {
      while (scheduled.length > 0) {
        const timer = scheduled.shift();
        if (!timer.cancelled) timer.callback();
      }
    },
  };
}

function jsonRequest(path, { method = "GET", body, headers = {} } = {}) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function responseData(response) {
  return (await response.json()).data;
}

async function createTask(
  handleRequest,
  question = "How should this task execute?",
) {
  const response = await handleRequest(
    jsonRequest(taskPath, { method: "POST", body: { question } }),
  );
  return responseData(response);
}

describe("API envelopes and request validation", () => {
  test("keeps health public and returns the standard success shape", async () => {
    const handleRequest = createApiHandler({ env: { NODE_ENV: "production" } });
    const response = await handleRequest(
      new Request("http://localhost/health"),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { status: "ok" } });
  });

  test("reports Valkey and MinIO readiness without exposing connection details", async () => {
    const handleRequest = createApiHandler({
      store: {
        async checkReadiness() {
          return {
            status: "not-ready",
            dependencies: { valkey: "ready", minio: "unavailable" },
          };
        },
      },
    });
    const response = await handleRequest(new Request("http://localhost/ready"));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      data: {
        status: "not-ready",
        dependencies: { valkey: "ready", minio: "unavailable" },
      },
    });
  });

  test("returns 202 until a worker acknowledges active cancellation", async () => {
    const task = {
      id: "523e4567-e89b-42d3-a456-426614174000",
      question: "A sufficiently long worker cancellation question?",
      config: {
        depth: "standard",
        maxSources: 10,
        maxIterations: 3,
        maxDurationSeconds: 120,
      },
      status: "processing",
      createdAt: "2026-10-30T00:00:00.000Z",
      updatedAt: "2026-10-30T00:00:01.000Z",
      cancellationRequested: true,
    };
    const handleRequest = createApiHandler({
      env: { NODE_ENV: "test" },
      store: {
        async cancelTask() {
          return task;
        },
      },
    });
    const response = await handleRequest(
      new Request(`http://localhost${taskPath}/${task.id}/cancel`, {
        method: "POST",
      }),
    );

    expect(response.status).toBe(202);
    const cancellation = await responseData(response);
    expect(cancellation.status).toBe("processing");
    expect(cancellation.cancellationRequested).toBe(true);
  });

  test("rejects protected routes in production until auth is configured", async () => {
    const handleRequest = createApiHandler({ env: { NODE_ENV: "production" } });
    const response = await handleRequest(
      new Request(`http://localhost${taskPath}`),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "AUTH_NOT_CONFIGURED" },
    });
  });

  test("validates content type, JSON syntax, question length, and config limits", async () => {
    const { handleRequest } = createHarness();
    const wrongType = await handleRequest(
      new Request(`http://localhost${taskPath}`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "hello world",
      }),
    );
    const malformed = await handleRequest(
      new Request(`http://localhost${taskPath}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{broken",
      }),
    );
    const invalidQuestion = await handleRequest(
      jsonRequest(taskPath, { method: "POST", body: { question: "short" } }),
    );
    const invalidConfig = await handleRequest(
      jsonRequest(taskPath, {
        method: "POST",
        body: {
          question: "A sufficiently long question?",
          config: { maxSources: 100 },
        },
      }),
    );
    const invalidQueueOptions = await handleRequest(
      jsonRequest(taskPath, {
        method: "POST",
        body: {
          question: "A sufficiently long question?",
          queueOptions: { priority: 11 },
        },
      }),
    );

    expect(wrongType.status).toBe(415);
    expect(malformed.status).toBe(400);
    expect(invalidQuestion.status).toBe(400);
    expect(invalidConfig.status).toBe(400);
    expect(invalidQueueOptions.status).toBe(400);
    expect(await invalidQuestion.json()).toMatchObject({
      error: { code: "VALIDATION_ERROR" },
    });
  });

  test("rejects malformed percent-encoded resource identifiers", async () => {
    const { handleRequest } = createHarness();
    const response = await handleRequest(
      new Request(`http://localhost${taskPath}/%E0%A4%A`),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "INVALID_PATH_PARAMETER" },
    });
  });

  test("rejects a JSON body larger than one mebibyte", async () => {
    const { handleRequest } = createHarness();
    const body = `{"question":"${"x".repeat(1_048_580)}"}`;
    const response = await handleRequest(
      new Request(`http://localhost${taskPath}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      error: { code: "PAYLOAD_TOO_LARGE" },
    });
  });
});

describe("authentication routes", () => {
  function createAuthHandler(overrides = {}) {
    const auth = {
      instance: {
        handler: async () =>
          Response.json({ ok: true, handled: "by-auth" }, { status: 200 }),
      },
      listWorkspaces: async (userId) => [
        {
          id: `workspace-${userId}`,
          role: "owner",
          createdAt: "2026-10-31T00:00:00.000Z",
        },
      ],
      ...overrides,
    };
    return createApiHandler({
      env: { NODE_ENV: "test" },
      auth,
      authenticate: () => ({ userId: "user-1", workspaceId: "workspace-1" }),
    });
  }

  test("delegates public auth routes to the auth handler", async () => {
    const handleRequest = createAuthHandler();
    const response = await handleRequest(
      new Request("http://localhost/api/auth/sign-in/email", {
        method: "POST",
        body: "{}",
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, handled: "by-auth" });
  });

  test("returns 503 when auth routes are requested without configuration", async () => {
    const handleRequest = createApiHandler({ env: { NODE_ENV: "test" } });
    const response = await handleRequest(
      new Request("http://localhost/api/auth/sign-in/email", {
        method: "POST",
        body: "{}",
      }),
    );
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("AUTH_NOT_CONFIGURED");
  });

  test("lists workspaces for the authenticated identity", async () => {
    const handleRequest = createAuthHandler();
    const response = await handleRequest(
      new Request("http://localhost/api/v1/workspaces"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: [
        {
          id: "workspace-user-1",
          role: "owner",
          createdAt: "2026-10-31T00:00:00.000Z",
        },
      ],
    });
  });

  test("fails closed for protected routes in production without auth", async () => {
    const handleRequest = createApiHandler({ env: { NODE_ENV: "production" } });
    const response = await handleRequest(
      new Request("http://localhost/api/v1/workspaces"),
    );
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("AUTH_NOT_CONFIGURED");
  });
});

describe("research task lifecycle", () => {
  test("creates, lists, tracks, and returns a synthetic result", async () => {
    const harness = createHarness();
    const task = await createTask(harness.handleRequest);

    expect(task.status).toBe("queued");
    expect(task.config).toEqual({
      depth: "standard",
      maxSources: 10,
      maxIterations: 3,
      maxDurationSeconds: 300,
      requiresApproval: false,
    });

    const listed = await responseData(
      await harness.handleRequest(new Request(`http://localhost${taskPath}`)),
    );
    expect(listed).toHaveLength(1);

    const incompleteResult = await harness.handleRequest(
      new Request(`http://localhost${taskPath}/${task.id}/result`),
    );
    expect(incompleteResult.status).toBe(409);

    harness.runScheduled();
    const status = await responseData(
      await harness.handleRequest(
        new Request(`http://localhost${taskPath}/${task.id}/status`),
      ),
    );
    const result = await responseData(
      await harness.handleRequest(
        new Request(`http://localhost${taskPath}/${task.id}/result`),
      ),
    );
    expect(status.status).toBe("completed");
    expect(result.synthetic).toBe(true);
    expect(result.sourceIds).toEqual([]);
  });

  test("cancels queued tasks and rejects a second cancellation", async () => {
    const harness = createHarness();
    const task = await createTask(harness.handleRequest);
    const response = await harness.handleRequest(
      new Request(`http://localhost${taskPath}/${task.id}/cancel`, {
        method: "POST",
      }),
    );

    expect((await responseData(response)).status).toBe("cancelled");
    const repeated = await harness.handleRequest(
      new Request(`http://localhost${taskPath}/${task.id}/cancel`, {
        method: "POST",
      }),
    );
    expect(repeated.status).toBe(409);
  });

  test("pauses for approval and resumes as a linked task", async () => {
    const harness = createHarness({
      executor: (_task, controls) => {
        controls.schedule(() => controls.awaitApproval(), 0);
      },
    });
    const task = await createTask(
      harness.handleRequest,
      "Should this research plan be approved?",
    );
    harness.runScheduled();

    const status = await responseData(
      await harness.handleRequest(
        new Request(`http://localhost${taskPath}/${task.id}/status`),
      ),
    );
    expect(status.status).toBe("awaiting_approval");

    const response = await harness.handleRequest(
      jsonRequest(`${taskPath}/${task.id}/approve`, {
        method: "POST",
        body: { approved: true, feedback: "Looks good." },
      }),
    );
    expect(response.status).toBe(202);
    const resumed = await responseData(response);
    expect(resumed.retryOf).toBe(task.id);
    expect(resumed.status).toBe("queued");
  });

  test("rejects approval for a task that is not paused", async () => {
    const harness = createHarness();
    const task = await createTask(harness.handleRequest);
    const response = await harness.handleRequest(
      jsonRequest(`${taskPath}/${task.id}/approve`, {
        method: "POST",
        body: { approved: true },
      }),
    );
    expect(response.status).toBe(409);
  });

  test("retries failed tasks as a new task linked to the original", async () => {
    const harness = createHarness({
      executor(_task, controls) {
        controls.fail();
      },
    });
    const failedTask = await createTask(harness.handleRequest);
    expect(failedTask.status).toBe("failed");

    const retryResponse = await harness.handleRequest(
      new Request(`http://localhost${taskPath}/${failedTask.id}/retry`, {
        method: "POST",
      }),
    );
    const retriedTask = await responseData(retryResponse);

    expect(retryResponse.status).toBe(202);
    expect(retriedTask.id).not.toBe(failedTask.id);
    expect(retriedTask.retryOf).toBe(failedTask.id);
    expect(retriedTask.status).toBe("failed");
  });

  test("scopes task access to the authenticated identity", async () => {
    const authenticate = (request) => ({
      userId:
        request.headers.get("authorization") === "Bearer second"
          ? "second"
          : "first",
      workspaceId: "workspace",
    });
    const harness = createHarness({ apiOptions: { authenticate } });
    const taskResponse = await harness.handleRequest(
      jsonRequest(taskPath, {
        method: "POST",
        body: { question: "How is identity scope enforced?" },
      }),
    );
    const task = await responseData(taskResponse);
    const response = await harness.handleRequest(
      new Request(`http://localhost${taskPath}/${task.id}`, {
        headers: { authorization: "Bearer second" },
      }),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: "NOT_FOUND" },
    });
  });

  test("applies an in-memory per-identity request limit", async () => {
    const harness = createHarness({ apiOptions: { rateLimit: 1 } });
    const first = await harness.handleRequest(
      new Request(`http://localhost${taskPath}`),
    );
    const second = await harness.handleRequest(
      new Request(`http://localhost${taskPath}`),
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
  });
});

describe("document API", () => {
  test("uploads allowed files, serves scoped content, and supports status and deletion", async () => {
    const { handleRequest } = createHarness();
    const formData = new FormData();
    formData.append(
      "file",
      new File(["research notes"], "../notes.txt", { type: "text/plain" }),
    );
    const uploaded = await handleRequest(
      new Request(`http://localhost${documentPath}`, {
        method: "POST",
        body: formData,
      }),
    );
    const document = await responseData(uploaded);

    expect(uploaded.status).toBe(201);
    expect(document.filename).toBe("notes.txt");
    expect(document.status).toBe("uploaded");
    expect(document.bytes).toBeUndefined();

    const details = await responseData(
      await handleRequest(
        new Request(`http://localhost${documentPath}/${document.id}`),
      ),
    );
    expect(details).not.toHaveProperty("bytes");
    const download = await handleRequest(
      new Request(`http://localhost${documentPath}/${document.id}/content`),
    );
    expect(download.headers.get("content-type")).toBe("text/plain");
    expect(await download.text()).toBe("research notes");
    const status = await responseData(
      await handleRequest(
        new Request(`http://localhost${documentPath}/${document.id}/status`),
      ),
    );
    expect(status.status).toBe("uploaded");

    const deleted = await handleRequest(
      new Request(`http://localhost${documentPath}/${document.id}`, {
        method: "DELETE",
      }),
    );
    expect(await responseData(deleted)).toEqual({
      id: document.id,
      deleted: true,
    });
    expect(
      (
        await handleRequest(
          new Request(`http://localhost${documentPath}/${document.id}`),
        )
      ).status,
    ).toBe(404);
  });

  test("enforces the total in-memory document byte budget", async () => {
    const { handleRequest } = createHarness({
      storeOptions: { maxDocumentBytesTotal: 3 },
    });
    const formData = new FormData();
    formData.append(
      "file",
      new File(["four"], "notes.txt", { type: "text/plain" }),
    );
    const response = await handleRequest(
      new Request(`http://localhost${documentPath}`, {
        method: "POST",
        body: formData,
      }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "DOCUMENT_CAPACITY_REACHED" },
    });
  });

  test("rejects unsupported media types, empty files, and oversized uploads", async () => {
    const { handleRequest } = createHarness();
    const unsupportedForm = new FormData();
    unsupportedForm.append(
      "file",
      new File(["bad"], "script.js", { type: "application/javascript" }),
    );
    const unsupported = await handleRequest(
      new Request(`http://localhost${documentPath}`, {
        method: "POST",
        body: unsupportedForm,
      }),
    );
    const emptyForm = new FormData();
    emptyForm.append("file", new File([], "empty.txt", { type: "text/plain" }));
    const empty = await handleRequest(
      new Request(`http://localhost${documentPath}`, {
        method: "POST",
        body: emptyForm,
      }),
    );
    const oversizedForm = new FormData();
    oversizedForm.append(
      "file",
      new File([new Uint8Array(5_242_881)], "large.txt", {
        type: "text/plain",
      }),
    );
    const oversized = await handleRequest(
      new Request(`http://localhost${documentPath}`, {
        method: "POST",
        body: oversizedForm,
      }),
    );

    expect(unsupported.status).toBe(415);
    expect(empty.status).toBe(400);
    expect(oversized.status).toBe(413);
  });
});

describe("server-sent events", () => {
  test("streams replayable events and releases the subscriber on cancellation", async () => {
    const harness = createHarness();
    const task = await createTask(harness.handleRequest);
    const response = await harness.handleRequest(
      new Request(`http://localhost${taskPath}/${task.id}/events`),
    );
    const reader = response.body.getReader();
    const connected = await reader.read();
    const firstEvent = await reader.read();

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(new TextDecoder().decode(connected.value)).toContain(": connected");
    expect(new TextDecoder().decode(firstEvent.value)).toContain(
      "event: task.created",
    );
    expect(harness.store.eventBroker.subscriberCount(task.id)).toBe(1);

    await reader.cancel();
    expect(harness.store.eventBroker.subscriberCount(task.id)).toBe(0);
  });

  test("sends heartbeats and clears the timer when the client disconnects", async () => {
    const harness = createHarness({ apiOptions: { heartbeatIntervalMs: 5 } });
    const task = await createTask(harness.handleRequest);
    const response = await harness.handleRequest(
      new Request(`http://localhost${taskPath}/${task.id}/events`),
    );
    const reader = response.body.getReader();
    await reader.read();
    await reader.read();
    await reader.read();
    const heartbeat = await reader.read();

    expect(new TextDecoder().decode(heartbeat.value)).toContain(": heartbeat ");
    await reader.cancel();
    expect(harness.store.eventBroker.subscriberCount(task.id)).toBe(0);
  });

  test("limits concurrent subscribers per task", async () => {
    const harness = createHarness({
      storeOptions: { maxEventSubscribers: 1 },
    });
    const task = await createTask(harness.handleRequest);
    const firstResponse = await harness.handleRequest(
      new Request(`http://localhost${taskPath}/${task.id}/events`),
    );
    const secondResponse = await harness.handleRequest(
      new Request(`http://localhost${taskPath}/${task.id}/events`),
    );

    expect(secondResponse.status).toBe(429);
    expect(await secondResponse.json()).toMatchObject({
      error: { code: "TOO_MANY_EVENT_SUBSCRIBERS" },
    });
    await firstResponse.body.cancel();
  });

  test("resumes after Last-Event-ID and reports replay gaps", async () => {
    const harness = createHarness({ storeOptions: { maxEventHistory: 1 } });
    const task = await createTask(harness.handleRequest);
    const response = await harness.handleRequest(
      new Request(`http://localhost${taskPath}/${task.id}/events`, {
        headers: { "last-event-id": "0" },
      }),
    );
    const reader = response.body.getReader();
    await reader.read();
    const reset = await reader.read();
    const replayedEvent = await reader.read();
    const text =
      new TextDecoder().decode(reset.value) +
      new TextDecoder().decode(replayedEvent.value);

    expect(text).toContain("event: stream.reset");
    expect(text).toContain("event: task.queued");
    await reader.cancel();
  });

  test("rejects progress events that do not match the event schema", async () => {
    const harness = createHarness();
    const task = await createTask(harness.handleRequest);

    expect(() =>
      harness.store.eventBroker.publish(
        task.id,
        "research.progress",
        { percent: 101, message: "Invalid progress" },
        new Date().toISOString(),
      ),
    ).toThrow();
  });

  test("rejects malformed Last-Event-ID values", async () => {
    const harness = createHarness();
    const task = await createTask(harness.handleRequest);
    const response = await harness.handleRequest(
      new Request(`http://localhost${taskPath}/${task.id}/events`, {
        headers: { "last-event-id": "not-an-id" },
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "INVALID_LAST_EVENT_ID" },
    });
  });
});

describe("document ingestion progress response", () => {
  test("returns real worker stage progress in document status", async () => {
    const documentId = "00000000-0000-4000-8000-000000000099";
    const document = {
      id: documentId,
      filename: "sample.pdf",
      mediaType: "application/pdf",
      size: 4096,
      status: "processing",
      createdAt: new Date().toISOString(),
      progress: {
        percent: 65,
        stage: "chunk-persistence",
        message: "Saving normalized document chunks.",
      },
    };
    const handleRequest = createApiHandler({
      env: { NODE_ENV: "test" },
      authenticate: () => ({ userId: "user-a", workspaceId: "workspace-a" }),
      store: { getDocument: async () => document },
    });
    const response = await handleRequest(
      new Request(`http://localhost/api/v1/documents/${documentId}/status`),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({
      id: documentId,
      status: "processing",
      progress: {
        percent: 65,
        stage: "chunk-persistence",
      },
    });
  });
});
