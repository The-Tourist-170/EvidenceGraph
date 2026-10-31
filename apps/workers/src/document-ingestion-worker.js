import {
  getDatabaseConfig,
  getMinioConfig,
  getWorkerConfig,
} from "@evidencegraph/config";
import { createObjectStorage } from "@evidencegraph/object-storage";
import { createPostgresPersistence } from "@evidencegraph/persistence";
import { documentIngestionQueueName } from "@evidencegraph/queue";
import { executeDocumentIngestion } from "./executors/document-ingestion.js";
import { startWorkerProcess } from "./worker-runtime.js";

export async function startDocumentIngestionWorker(options = {}) {
  const env = options.env ?? process.env;
  const config = options.config ?? getWorkerConfig(env);
  const objectStorage =
    options.objectStorage ??
    createObjectStorage({ config: getMinioConfig(env) });
  const persistence =
    options.persistence ??
    createPostgresPersistence({ config: getDatabaseConfig(env), env });
  try {
    await Promise.all([objectStorage.initialize(), persistence.initialize()]);
  } catch (error) {
    objectStorage.close();
    await persistence.close();
    throw error;
  }
  return startWorkerProcess({
    queueName: documentIngestionQueueName,
    workerName: "document-ingestion-worker",
    concurrency: config.documentConcurrency,
    timeoutForJob: () => config.documentTimeoutSeconds * 1_000,
    processor: (job, context) =>
      executeDocumentIngestion(job, context, {
        objectStorage,
        persistence,
        graphRepository: persistence.graphRepository,
      }),
    objectStorage,
    resources: [persistence],
    workerConfig: config,
    ...options,
  });
}

if (import.meta.main) await startDocumentIngestionWorker();
