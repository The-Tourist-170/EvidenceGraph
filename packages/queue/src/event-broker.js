import { researchEventSchema } from "./contracts.js";

const encoder = new TextEncoder();
const lineBreak = String.fromCharCode(10);
const terminalTypes = new Set([
  "task.completed",
  "task.failed",
  "task.cancelled",
]);
const reserveSubscriberScript = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], 60) end
if count > tonumber(ARGV[1]) then
  redis.call('DECR', KEYS[1])
  return 0
end
return 1
`;
const releaseSubscriberScript = `
local count = redis.call('DECR', KEYS[1])
if count <= 0 then redis.call('DEL', KEYS[1]) end
return count
`;

function parseEntries(rows) {
  return rows.map(([streamId, values]) => {
    const fields = Object.fromEntries(
      Array.from({ length: values.length / 2 }, (_, index) => [
        values[index * 2],
        values[index * 2 + 1],
      ]),
    );
    return {
      streamId,
      event: researchEventSchema.parse(JSON.parse(fields.payload)),
    };
  });
}

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

export function createRedisEventBroker({
  redis,
  maxHistory = 100,
  maxSubscribers = 32,
}) {
  function eventKey(taskId) {
    return `evidencegraph:events:${taskId}`;
  }

  function sequenceKey(taskId) {
    return `evidencegraph:event-sequence:${taskId}`;
  }

  function subscriberKey(taskId) {
    return `evidencegraph:event-subscribers:${taskId}`;
  }

  async function publish(taskId, type, data, timestamp) {
    const id = await redis.incr(sequenceKey(taskId));
    const event = researchEventSchema.parse({
      id,
      taskId,
      type,
      data,
      timestamp,
    });
    const key = eventKey(taskId);
    await redis.xadd(
      key,
      "MAXLEN",
      "~",
      maxHistory,
      "*",
      "payload",
      JSON.stringify(event),
    );
    await Promise.all([
      redis.expire(key, 30 * 24 * 60 * 60),
      redis.expire(sequenceKey(taskId), 30 * 24 * 60 * 60),
    ]);
    return event;
  }

  async function replay(taskId, afterId) {
    const rows = await redis.xrange(eventKey(taskId), "-", "+");
    const entries = parseEntries(rows);
    const oldestId = entries[0]?.event.id;
    const gap =
      afterId !== null && oldestId !== undefined && afterId < oldestId - 1;
    return {
      cursor: entries.at(-1)?.streamId ?? "0-0",
      events:
        afterId === null || gap
          ? entries
          : entries.filter(({ event }) => event.id > afterId),
      gap,
      oldestId,
    };
  }

  async function subscriberCount(taskId) {
    return Number((await redis.get(subscriberKey(taskId))) ?? 0);
  }

  async function createStreamResponse({
    taskId,
    afterId,
    isTerminal,
    heartbeatIntervalMs = 15_000,
    signal,
  }) {
    const key = subscriberKey(taskId);
    const reserved = await redis.eval(
      reserveSubscriberScript,
      1,
      key,
      maxSubscribers,
    );
    if (reserved !== 1) {
      const error = new Error("Too many event subscribers for this task.");
      error.status = 429;
      error.code = "TOO_MANY_EVENT_SUBSCRIBERS";
      throw error;
    }

    const subscriber = redis.duplicate();
    let released = false;
    let controller;
    let closed = false;

    async function release() {
      if (released) return;
      released = true;
      closed = true;
      signal?.removeEventListener("abort", release);
      subscriber.disconnect();
      await redis.eval(releaseSubscriberScript, 1, key);
      try {
        controller?.close();
      } catch {
        return;
      }
    }

    try {
      await subscriber.ping();
      const replayed = await replay(taskId, afterId);
      const stream = new ReadableStream(
        {
          async start(streamController) {
            controller = streamController;
            const enqueue = (chunk) => {
              if (closed) return false;
              if (
                controller.desiredSize !== null &&
                controller.desiredSize <= 0
              ) {
                void release();
                return false;
              }
              controller.enqueue(chunk);
              return true;
            };
            enqueue(encoder.encode(`: connected${lineBreak}${lineBreak}`));
            signal?.addEventListener("abort", release, { once: true });
            if (signal?.aborted) {
              await release();
              return;
            }
            if (replayed.gap) {
              enqueue(
                encoder.encode(
                  `event: stream.reset${lineBreak}data: ${JSON.stringify({ reason: "replay_gap", oldestAvailableId: replayed.oldestId })}${lineBreak}${lineBreak}`,
                ),
              );
            }
            let cursor = replayed.cursor;
            for (const { event, streamId } of replayed.events) {
              if (!enqueue(serializeEvent(event))) return;
              cursor = streamId;
              if (terminalTypes.has(event.type)) {
                await release();
                return;
              }
            }
            if (await isTerminal()) {
              await release();
              return;
            }

            while (!closed) {
              try {
                const result = await subscriber.xread(
                  "BLOCK",
                  heartbeatIntervalMs,
                  "COUNT",
                  maxHistory,
                  "STREAMS",
                  eventKey(taskId),
                  cursor,
                );
                if (!result) {
                  await redis.expire(key, 60);
                  enqueue(
                    encoder.encode(
                      `: heartbeat ${Date.now()}${lineBreak}${lineBreak}`,
                    ),
                  );
                  continue;
                }
                const entries = parseEntries(result[0][1]);
                for (const { event, streamId } of entries) {
                  if (!enqueue(serializeEvent(event))) return;
                  cursor = streamId;
                  if (terminalTypes.has(event.type)) {
                    await release();
                    return;
                  }
                }
              } catch {
                await release();
              }
            }
          },
          cancel() {
            return release();
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
    } catch (error) {
      await release();
      throw error;
    }
  }

  return {
    createStreamResponse,
    maxSubscribers,
    publish,
    replay,
    subscriberCount,
  };
}
