import { UnrecoverableError } from "bullmq";
import { IntegrationError, runResearch } from "@evidencegraph/ai";

function executeSyntheticResearch(job, context) {
  return (async () => {
    const stages = [
      {
        stage: "planning",
        percent: 20,
        message: "Planning the research steps.",
      },
      {
        stage: "evidence-review",
        percent: 60,
        message: "Reviewing synthetic evidence.",
      },
      {
        stage: "synthesis",
        percent: 90,
        message: "Preparing a synthetic summary.",
      },
    ];

    for (const stage of stages) {
      await context.throwIfCancelled();
      await context.waitForStage();
      await context.reportProgress(stage);
    }

    return {
      summary: `Synthetic research result for: ${job.data.question}`,
      claims: [],
      sourceIds: [],
      synthetic: true,
    };
  })();
}

export async function executeResearch(job, context, integrations) {
  if (!integrations) return executeSyntheticResearch(job, context);
  try {
    return await runResearch({
      question: job.data.question,
      maxSources: job.data.config.maxSources,
      signal: context.signal,
      onProgress: (progress) => context.reportProgress(progress),
      integrations,
    });
  } catch (error) {
    if (error instanceof IntegrationError && !error.retryable) {
      throw new UnrecoverableError(error.code);
    }
    throw error;
  }
}
