export async function executeResearch(job, context) {
  const stages = [
    { stage: "planning", percent: 20, message: "Planning the research steps." },
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
}
