import { getDatabaseConfig, getWorkerConfig } from "@evidencegraph/config";
import {
  createMemoryCheckpointer,
  createPostgresCheckpointer,
  createResearchGraph,
  createResearchIntegrations,
} from "@evidencegraph/ai";
import { createPostgresPersistence } from "@evidencegraph/persistence";
import { researchQueueName } from "@evidencegraph/queue";
import { logger } from "@evidencegraph/shared";
import { executeResearch } from "./executors/research.js";
import { startWorkerProcess } from "./worker-runtime.js";

export async function startResearchWorker(options = {}) {
  const env = options.env ?? process.env;
  const config = options.config ?? getWorkerConfig(env);
  const integrations =
    options.integrations !== undefined
      ? options.integrations
      : createResearchIntegrations({ env });
  let persistence;
  let workflow = null;
  if (integrations) {
    persistence =
      options.persistence ??
      createPostgresPersistence({ config: getDatabaseConfig(env), env });
    await persistence.initialize();
    const checkpointer =
      options.checkpointer ??
      (env.NODE_ENV === "test"
        ? createMemoryCheckpointer()
        : await createPostgresCheckpointer({
            connectionString: getDatabaseConfig(env).url,
          }));
    workflow = {
      graph: createResearchGraph({
        llm: integrations.llm,
        search: integrations.search,
        embeddings: integrations.embeddings,
        reranker: integrations.reranker,
        vectorRepository: persistence.vectorRepository,
        graphRepository: persistence.graphRepository,
        reportStore: persistence,
        checkpointer,
      }),
    };
  }
  logger.info("Research integrations initialized", {
    enabled: integrations !== null,
    ...(integrations
      ? { capabilities: integrations.available }
      : { reason: "AI_INTEGRATIONS_ENABLED is false" }),
  });
  return startWorkerProcess({
    queueName: researchQueueName,
    workerName: "research-worker",
    concurrency: config.researchConcurrency,
    timeoutForJob: (job) => job.data.config.maxDurationSeconds * 1_000,
    processor: (job, context) =>
      executeResearch(job, context, integrations, workflow),
    resources: persistence ? [persistence] : [],
    workerConfig: config,
    ...options,
  });
}

if (import.meta.main) await startResearchWorker();
