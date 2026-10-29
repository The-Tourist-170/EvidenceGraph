import { researchEventSchema } from "./contracts.js";

export function createEventBroker({
  maxHistory = 100,
  maxSubscribers = 32,
} = {}) {
  const histories = new Map();
  const listeners = new Map();
  const nextIds = new Map();

  function publish(taskId, type, data, timestamp) {
    const id = nextIds.get(taskId) ?? 1;
    const event = researchEventSchema.parse({
      id,
      taskId,
      type,
      data,
      timestamp,
    });
    nextIds.set(taskId, id + 1);

    const history = histories.get(taskId) ?? [];
    history.push(event);
    if (history.length > maxHistory) history.shift();
    histories.set(taskId, history);

    for (const listener of listeners.get(taskId) ?? []) {
      listener(event);
    }
    return event;
  }

  function replay(taskId, afterId) {
    const events = histories.get(taskId) ?? [];
    if (afterId === null) {
      return { gap: false, events };
    }

    const oldestId = events[0]?.id;
    if (oldestId !== undefined && afterId < oldestId - 1) {
      return { gap: true, oldestId, events };
    }

    return { gap: false, events: events.filter((event) => event.id > afterId) };
  }

  function subscribe(taskId, listener) {
    const taskListeners = listeners.get(taskId) ?? new Set();
    if (taskListeners.size >= maxSubscribers) {
      return null;
    }

    taskListeners.add(listener);
    listeners.set(taskId, taskListeners);
    return () => {
      taskListeners.delete(listener);
      if (taskListeners.size === 0) {
        listeners.delete(taskId);
      }
    };
  }

  function subscriberCount(taskId) {
    return listeners.get(taskId)?.size ?? 0;
  }

  return { maxSubscribers, publish, replay, subscribe, subscriberCount };
}

const encoder = new TextEncoder();
const lineBreak = String.fromCharCode(10);

function serializeEvent(event) {
  return encoder.encode(
    [
      `id: ${event.id}`,
      `event: ${event.type}`,
      `data: ${JSON.stringify(event)}`,
      "",
      "",
    ].join(lineBreak),
  );
}

export function createEventStreamResponse({
  taskId,
  broker,
  afterId,
  isTerminal,
  heartbeatIntervalMs = 15_000,
  signal,
}) {
  let unsubscribe = () => {};
  let heartbeat;
  let closeStream = () => {};
  let closed = false;

  const stream = new ReadableStream(
    {
      start(controller) {
        const close = () => {
          if (closed) return;
          closed = true;
          clearInterval(heartbeat);
          unsubscribe();
          signal?.removeEventListener("abort", close);
          try {
            controller.close();
          } catch {
            return;
          }
        };
        closeStream = close;

        const enqueueEvent = (event) => {
          if (closed) return;
          if (controller.desiredSize !== null && controller.desiredSize <= 0) {
            close();
            return;
          }
          controller.enqueue(serializeEvent(event));
          if (
            ["task.completed", "task.failed", "task.cancelled"].includes(
              event.type,
            )
          ) {
            close();
          }
        };

        controller.enqueue(
          encoder.encode(`: connected${lineBreak}${lineBreak}`),
        );
        unsubscribe = broker.subscribe(taskId, enqueueEvent) ?? (() => {});
        signal?.addEventListener("abort", close, { once: true });
        if (signal?.aborted) {
          close();
          return;
        }

        const replay = broker.replay(taskId, afterId);
        if (replay.gap) {
          controller.enqueue(
            encoder.encode(
              `event: stream.reset${lineBreak}data: ${JSON.stringify({ reason: "replay_gap", oldestAvailableId: replay.oldestId })}${lineBreak}${lineBreak}`,
            ),
          );
        }
        for (const event of replay.events) {
          enqueueEvent(event);
          if (closed) return;
        }

        if (isTerminal() || broker.subscriberCount(taskId) === 0) {
          close();
          return;
        }

        heartbeat = setInterval(() => {
          if (closed) return;
          if (controller.desiredSize !== null && controller.desiredSize <= 0) {
            close();
            return;
          }
          controller.enqueue(
            encoder.encode(`: heartbeat ${Date.now()}${lineBreak}${lineBreak}`),
          );
        }, heartbeatIntervalMs);
      },
      cancel() {
        closeStream();
      },
    },
    { highWaterMark: 128 },
  );

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
    },
  });
}
