import { getActiveWorkspaceId } from "./api.js";

/**
 * Reads an SSE endpoint with fetch so workspace headers and credentials are
 * applied, which EventSource cannot do.
 */
export async function streamEvents({ url, signal, onEvent, onEnd }) {
  let lastEventId = null;
  const headers = { accept: "text/event-stream" };
  const workspaceId = getActiveWorkspaceId();
  if (workspaceId) headers["x-workspace-id"] = workspaceId;
  if (lastEventId) headers["last-event-id"] = lastEventId;

  const response = await fetch(url, {
    credentials: "include",
    headers,
    signal,
  });
  if (!response.ok || !response.body) {
    throw new Error(`Event stream failed with status ${response.status}.`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const idLine = frame
          .split("\n")
          .find((line) => line.startsWith("id: "));
        const dataLine = frame
          .split("\n")
          .find((line) => line.startsWith("data: "));
        if (dataLine) {
          if (idLine) lastEventId = idLine.slice(4).trim();
          try {
            onEvent?.({
              id: idLine?.slice(4).trim(),
              data: JSON.parse(dataLine.slice(6)),
            });
          } catch {
            onEvent?.({ id: idLine?.slice(4).trim(), data: null });
          }
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
    onEnd?.();
  }
}
