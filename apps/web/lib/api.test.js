import { afterEach, describe, expect, test } from "bun:test";
import {
  ApiClientError,
  api,
  authApi,
  setActiveWorkspaceId,
  uploadDocument,
} from "./api.js";

const originalFetch = globalThis.fetch;
const originalXhr = globalThis.XMLHttpRequest;

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.XMLHttpRequest = originalXhr;
  setActiveWorkspaceId(null);
});

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("web API client", () => {
  test("returns the success envelope payload with credentials and workspace", async () => {
    globalThis.fetch = async (path, options) => {
      expect(path).toBe("/api/v1/research-tasks");
      expect(options.credentials).toBe("include");
      expect(options.headers["x-workspace-id"]).toBe("workspace-9");
      return jsonResponse({ data: [{ id: "task-1" }] });
    };
    setActiveWorkspaceId("workspace-9");
    expect(await api.listTasks()).toEqual([{ id: "task-1" }]);
  });

  test("maps error envelopes to typed client errors", async () => {
    globalThis.fetch = async () =>
      jsonResponse(
        {
          error: {
            code: "TASK_NOT_RETRYABLE",
            message: "Only failed tasks can be retried.",
          },
        },
        409,
      );
    const error = await api.retryTask("task-1").catch((value) => value);
    expect(error).toBeInstanceOf(ApiClientError);
    expect(error.status).toBe(409);
    expect(error.code).toBe("TASK_NOT_RETRYABLE");
    expect(error.message).toBe("Only failed tasks can be retried.");
  });

  test("uploads documents with byte progress, credentials, and workspace headers", async () => {
    let captured;
    class FakeXhr {
      constructor() {
        this.upload = {
          addEventListener: (_type, callback) => {
            this.uploadProgress = callback;
          },
        };
        this.listeners = {};
      }
      open(method, path) {
        this.method = method;
        this.path = path;
      }
      setRequestHeader(name, value) {
        this.headers ??= {};
        this.headers[name] = value;
      }
      addEventListener(type, callback) {
        this.listeners[type] = callback;
      }
      send(body) {
        captured = this;
        this.body = body;
        this.uploadProgress({ lengthComputable: true, loaded: 50, total: 100 });
        this.status = 201;
        this.responseText = JSON.stringify({ data: { id: "doc-1" } });
        this.listeners.load();
      }
    }
    globalThis.XMLHttpRequest = FakeXhr;
    setActiveWorkspaceId("workspace-7");
    const progress = [];
    const document = await uploadDocument(
      new File(["hello"], "hello.txt", { type: "text/plain" }),
      { onProgress: (value) => progress.push(value) },
    );
    expect(document).toEqual({ id: "doc-1" });
    expect(captured.path).toBe("/api/v1/documents");
    expect(captured.method).toBe("POST");
    expect(captured.withCredentials).toBe(true);
    expect(captured.headers["x-workspace-id"]).toBe("workspace-7");
    expect(captured.body).toBeInstanceOf(FormData);
    expect(progress).toEqual([{ loaded: 50, total: 100, percent: 50 }]);
  });

  test("returns null for a missing session and surfaces auth failures", async () => {
    globalThis.fetch = async () => new Response("no session", { status: 401 });
    expect(await authApi.session()).toBeNull();

    globalThis.fetch = async () =>
      jsonResponse({ message: "Invalid email or password" }, 401);
    const error = await authApi
      .signIn({ email: "a@b.test", password: "nope" })
      .catch((value) => value);
    expect(error).toBeInstanceOf(ApiClientError);
    expect(error.message).toBe("Invalid email or password");
  });
});
