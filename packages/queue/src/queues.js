import { Queue, QueueEvents } from "bullmq";
import { createValkeyConnection } from "./connection.js";

export const researchQueueName = "research";
export const documentIngestionQueueName = "document-ingestion";
export const workerConcurrency = Object.freeze({
  research: 4,
  documentIngestion: 2,
});

export const defaultJobOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 1_000 },
  removeOnComplete: { age: 30 * 24 * 60 * 60, count: 10_000 },
  removeOnFail: { age: 30 * 24 * 60 * 60, count: 10_000 },
};

export function createQueueRuntime(config) {
  const connections = [];
  const createConnection = () => {
    const connection = createValkeyConnection(config);
    connections.push(connection);
    return connection;
  };

  const redis = createConnection();
  const researchQueue = new Queue(researchQueueName, {
    connection: createConnection(),
    defaultJobOptions,
  });
  const documentQueue = new Queue(documentIngestionQueueName, {
    connection: createConnection(),
    defaultJobOptions,
  });
  const researchEvents = new QueueEvents(researchQueueName, {
    connection: createConnection(),
  });
  const documentEvents = new QueueEvents(documentIngestionQueueName, {
    connection: createConnection(),
  });

  async function initialize() {
    let timeout;
    try {
      await Promise.race([
        Promise.all([
          redis.ping(),
          researchQueue.waitUntilReady(),
          documentQueue.waitUntilReady(),
          researchEvents.waitUntilReady(),
          documentEvents.waitUntilReady(),
        ]),
        new Promise((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Timed out connecting to Valkey.")),
            15_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }

  async function checkHealth() {
    const response = await redis.ping();
    if (response !== "PONG") throw new Error("Valkey health check failed.");
    return true;
  }

  async function getCounts() {
    const [research, documents] = await Promise.all([
      researchQueue.getJobCounts("wait", "active", "delayed", "failed"),
      documentQueue.getJobCounts("wait", "active", "delayed", "failed"),
    ]);
    return { research, documents };
  }

  async function close() {
    const componentResults = await Promise.allSettled([
      researchQueue.close(),
      documentQueue.close(),
      researchEvents.close(),
      documentEvents.close(),
    ]);
    const connectionResults = await Promise.allSettled(
      connections.map((connection) => {
        if (connection.status === "ready") return connection.quit();
        connection.disconnect();
      }),
    );
    const failure = [...componentResults, ...connectionResults].find(
      (result) => result.status === "rejected",
    );
    if (failure) throw failure.reason;
  }

  return {
    checkHealth,
    close,
    documentEvents,
    documentQueue,
    getCounts,
    initialize,
    redis,
    researchEvents,
    researchQueue,
  };
}
