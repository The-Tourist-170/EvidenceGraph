import { getWorkerConfig } from "@evidencegraph/config";
import { createResearchIntegrations } from "@evidencegraph/ai";
import { researchQueueName } from "@evidencegraph/queue";
import { executeResearch } from "./executors/research.js";
import { startWorkerProcess } from "./worker-runtime.js";

export function startResearchWorker(options = {}) {
  const env = options.env ?? process.env;
  const config = options.config ?? getWorkerConfig(env);
  const integrations =
    options.integrations ?? createResearchIntegrations({ env });
  return startWorkerProcess({
    queueName: researchQueueName,
    workerName: "research-worker",
    concurrency: config.researchConcurrency,
    timeoutForJob: (job) => job.data.config.maxDurationSeconds * 1_000,
    processor: (job, context) => executeResearch(job, context, integrations),
    workerConfig: config,
    ...options,
  });
}

if (import.meta.main) await startResearchWorker();
