import {
  getDatabaseConfig,
  getEmbeddingConfig,
  getIntegrationConfig,
  getMinioConfig,
  getWorkerConfig,
} from "@evidencegraph/config";
import { createEmbeddingClient } from "@evidencegraph/ai";
import { createObjectStorage } from "@evidencegraph/object-storage";
import { createPostgresPersistence } from "@evidencegraph/persistence";
import { documentIngestionQueueName } from "@evidencegraph/queue";
import { executeDocumentIngestion } from "./executors/document-ingestion.js";
import { startWorkerProcess } from "./worker-runtime.js";

function createEmbeddingClientFromEnv(env) {
  if (!getIntegrationConfig(env).enabled) return null;
  const config = getEmbeddingConfig(env);
  if (!config) {
    throw new Error(
      "Missing embedding configuration: EMBEDDING_MODEL_NAME. Set it in your .env file; see .env.example.",
    );
  }
  return createEmbeddingClient({ config });
}

export async function startDocumentIngestionWorker(options = {}) {
  const env = options.env ?? process.env;
  const config = options.config ?? getWorkerConfig(env);
  const objectStorage =
    options.objectStorage ??
    createObjectStorage({ config: getMinioConfig(env) });
  const persistence =
    options.persistence ??
    createPostgresPersistence({ config: getDatabaseConfig(env), env });
  const embeddings =
    options.embeddings !== undefined
      ? options.embeddings
      : createEmbeddingClientFromEnv(env);
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
        embeddings,
      }),
    objectStorage,
    resources: [persistence],
    workerConfig: config,
    ...options,
  });
}

if (import.meta.main) await startDocumentIngestionWorker();
