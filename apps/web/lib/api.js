export class ApiClientError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = "ApiClientError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

let activeWorkspaceId = null;

export function setActiveWorkspaceId(id) {
  activeWorkspaceId = id ?? null;
}

export function getActiveWorkspaceId() {
  return activeWorkspaceId;
}

async function request(path, { method = "GET", body, headers = {} } = {}) {
  const response = await fetch(path, {
    method,
    credentials: "include",
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(activeWorkspaceId ? { "x-workspace-id": activeWorkspaceId } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = payload?.error;
    throw new ApiClientError(
      response.status,
      error?.code ?? "REQUEST_FAILED",
      error?.message ?? `Request failed with status ${response.status}.`,
      error?.details,
    );
  }
  return payload.data;
}

export const api = {
  listTasks: () => request("/api/v1/research-tasks"),
  getTask: (id) => request(`/api/v1/research-tasks/${id}`),
  getTaskStatus: (id) => request(`/api/v1/research-tasks/${id}/status`),
  createTask: (body) =>
    request("/api/v1/research-tasks", { method: "POST", body }),
  cancelTask: (id) =>
    request(`/api/v1/research-tasks/${id}/cancel`, { method: "POST" }),
  retryTask: (id) =>
    request(`/api/v1/research-tasks/${id}/retry`, { method: "POST" }),
  approveTask: (id, decision) =>
    request(`/api/v1/research-tasks/${id}/approve`, {
      method: "POST",
      body: decision,
    }),
  getReport: (id) => request(`/api/v1/research-tasks/${id}/report`),
  listDocuments: () => request("/api/v1/documents"),
  deleteDocument: (id) =>
    request(`/api/v1/documents/${id}`, { method: "DELETE" }),
  listWorkspaces: () => request("/api/v1/workspaces"),
  eventsUrl: (id) => `/api/v1/research-tasks/${id}/events`,
};

export function uploadDocument(file, { onProgress } = {}) {
  const form = new FormData();
  form.append("file", file);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/v1/documents");
    xhr.withCredentials = true;
    if (activeWorkspaceId) {
      xhr.setRequestHeader("x-workspace-id", activeWorkspaceId);
    }
    xhr.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable) return;
      onProgress?.({
        loaded: event.loaded,
        total: event.total,
        percent: Math.min(100, Math.round((event.loaded / event.total) * 100)),
      });
    });
    xhr.addEventListener("load", () => {
      let payload;
      try {
        payload = JSON.parse(xhr.responseText);
      } catch {
        reject(
          new ApiClientError(
            xhr.status,
            "INVALID_RESPONSE",
            "Upload returned an invalid response.",
          ),
        );
        return;
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        const error = payload?.error;
        reject(
          new ApiClientError(
            xhr.status,
            error?.code ?? "UPLOAD_FAILED",
            error?.message ?? "Document upload failed.",
          ),
        );
        return;
      }
      resolve(payload.data);
    });
    xhr.addEventListener("error", () =>
      reject(
        new ApiClientError(0, "NETWORK_ERROR", "Upload connection failed."),
      ),
    );
    xhr.addEventListener("abort", () =>
      reject(new ApiClientError(0, "UPLOAD_ABORTED", "Upload was cancelled.")),
    );
    xhr.send(form);
  });
}

export const authApi = {
  async session() {
    const response = await fetch("/api/auth/get-session", {
      credentials: "include",
    });
    if (!response.ok) return null;
    const payload = await response.json().catch(() => null);
    if (!payload?.user) return null;
    return { user: payload.user, session: payload.session ?? null };
  },
  async signIn({ email, password }) {
    return authRequest("/api/auth/sign-in/email", { email, password });
  },
  async signUp({ email, password, name }) {
    return authRequest("/api/auth/sign-up/email", { email, password, name });
  },
  async signOut() {
    await fetch("/api/auth/sign-out", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: "{}",
    }).catch(() => {});
  },
};

async function authRequest(path, body) {
  const response = await fetch(path, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiClientError(
      response.status,
      payload?.code ?? payload?.error?.code ?? "AUTH_FAILED",
      payload?.message ??
        payload?.error?.message ??
        "Authentication request failed.",
    );
  }
  return payload;
}
