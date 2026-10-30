import { getWorkerConfig } from "@evidencegraph/config";
import { researchQueueName } from "@evidencegraph/queue";
import { executeResearch } from "./executors/research.js";
import { startWorkerProcess } from "./worker-runtime.js";

export function startResearchWorker(options = {}) {
  const config = options.config ?? getWorkerConfig(options.env ?? process.env);
  return startWorkerProcess({
    queueName: researchQueueName,
    workerName: "research-worker",
    concurrency: config.researchConcurrency,
    timeoutForJob: (job) => job.data.config.maxDurationSeconds * 1_000,
    processor: executeResearch,
    workerConfig: config,
    ...options,
  });
}

if (import.meta.main) await startResearchWorker();
