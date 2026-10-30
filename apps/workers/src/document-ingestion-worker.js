import { getMinioConfig, getWorkerConfig } from "@evidencegraph/config";
import { createObjectStorage } from "@evidencegraph/object-storage";
import { documentIngestionQueueName } from "@evidencegraph/queue";
import { executeDocumentIngestion } from "./executors/document-ingestion.js";
import { startWorkerProcess } from "./worker-runtime.js";

export async function startDocumentIngestionWorker(options = {}) {
  const env = options.env ?? process.env;
  const config = options.config ?? getWorkerConfig(env);
  const objectStorage =
    options.objectStorage ??
    createObjectStorage({ config: getMinioConfig(env) });
  try {
    await objectStorage.initialize();
  } catch (error) {
    objectStorage.close();
    throw error;
  }
  return startWorkerProcess({
    queueName: documentIngestionQueueName,
    workerName: "document-ingestion-worker",
    concurrency: config.documentConcurrency,
    timeoutForJob: () => config.documentTimeoutSeconds * 1_000,
    processor: (job, context) =>
      executeDocumentIngestion(job, context, objectStorage),
    objectStorage,
    workerConfig: config,
    ...options,
  });
}

if (import.meta.main) await startDocumentIngestionWorker();
