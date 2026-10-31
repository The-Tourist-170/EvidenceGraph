import { UnrecoverableError } from "bullmq";
import {
  IntegrationError,
  invokeResearchGraph,
  runResearch,
} from "@evidencegraph/ai";

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

async function executeGraphResearch(job, context, workflow) {
  const threadId = job.data.retryOf ?? job.data.taskId;
  const outcome = await invokeResearchGraph({
    graph: workflow.graph,
    input: {
      taskId: job.data.taskId,
      threadId,
      owner: job.data.owner,
      question: job.data.question,
      config: job.data.config,
    },
    threadId,
    resume: job.data.resume,
    signal: context.signal,
    onProgress: (progress) => context.reportProgress(progress),
  });
  if (outcome.interrupted) {
    await context.reportProgress({
      percent: 100,
      stage: "approval",
      message: "The research plan is awaiting human approval.",
    });
    throw new UnrecoverableError("TASK_AWAITING_APPROVAL");
  }
  if (outcome.state.status !== "completed" || !outcome.state.report) {
    throw new UnrecoverableError(
      outcome.state.error?.code ?? "RESEARCH_WORKFLOW_FAILED",
    );
  }
  const report = outcome.state.report;
  return {
    summary: report.summary,
    claims: report.claims.map((claim) => claim.text),
    sourceIds: report.sourceIds,
    synthetic: false,
  };
}

export async function executeResearch(job, context, integrations, workflow) {
  if (!integrations) return executeSyntheticResearch(job, context);
  try {
    if (workflow?.graph) {
      return await executeGraphResearch(job, context, workflow);
    }
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
