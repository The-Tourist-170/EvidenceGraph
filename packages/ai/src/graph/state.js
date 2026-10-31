import { Annotation } from "@langchain/langgraph";
import { z } from "zod";

export const researchGraphConfigSchema = z
  .object({
    depth: z.enum(["quick", "standard", "deep"]).default("standard"),
    maxSources: z.number().int().min(1).max(50).default(10),
    maxIterations: z.number().int().min(1).max(10).default(3),
    maxDurationSeconds: z.number().int().min(10).max(300).default(120),
    requiresApproval: z.boolean().default(false),
  })
  .strict();

export const retrievedChunkSchema = z
  .object({
    chunkId: z.string().uuid(),
    documentId: z.string().uuid(),
    content: z.string().min(1).max(20_000),
    score: z.number().finite(),
    metadata: z.record(z.unknown()).default({}),
  })
  .strict();

export const researchPlanSchema = z
  .object({
    subquestions: z.array(z.string().min(1).max(500)).max(10),
    queries: z.array(z.string().min(1).max(500)).max(10),
    sourceRequirements: z.string().max(2_000),
  })
  .strict();

export const evidenceEvaluationSchema = z
  .object({
    coverage: z.number().min(0).max(1),
    missing: z.array(z.string().max(500)).max(10),
    conflicts: z.array(z.string().max(500)).max(10),
    needsMoreResearch: z.boolean(),
  })
  .strict();

export const verificationSchema = z
  .object({
    supported: z
      .array(
        z
          .object({
            claim: z.string().min(1).max(2_000),
            sourceIds: z.array(z.string().min(1).max(128)).max(20),
          })
          .strict(),
      )
      .max(50),
    unsupported: z.array(z.string().max(2_000)).max(50),
    conflicts: z.array(z.string().max(2_000)).max(20),
    confidence: z.number().min(0).max(1),
  })
  .strict();

export const reportDraftSchema = z
  .object({
    title: z.string().min(1).max(300),
    summary: z.string().min(1).max(20_000),
    sections: z
      .array(
        z
          .object({
            heading: z.string().min(1).max(200),
            body: z.string().min(1).max(10_000),
          })
          .strict(),
      )
      .max(20),
    claims: z
      .array(
        z
          .object({
            text: z.string().min(1).max(2_000),
            sourceIds: z.array(z.string().min(1).max(128)).max(20),
          })
          .strict(),
      )
      .max(50),
    limitations: z.array(z.string().max(1_000)).max(20),
  })
  .strict();

export const approvalDecisionSchema = z
  .object({
    approved: z.boolean(),
    feedback: z.string().max(2_000).optional(),
  })
  .strict();

export const graphEvidenceSchema = z
  .object({
    entities: z
      .array(
        z
          .object({
            id: z.string().optional(),
            name: z.string().min(1).max(256),
            kind: z.string().min(1).max(80),
          })
          .strict(),
      )
      .max(200),
    relationships: z
      .array(
        z
          .object({
            from: z.string().min(1).max(256),
            to: z.string().min(1).max(256),
            type: z.string().min(1).max(80),
            confidence: z.number().min(0).max(1).optional(),
          })
          .strict(),
      )
      .max(200),
  })
  .strict();

export const graphInputSchema = z
  .object({
    taskId: z.string().uuid(),
    threadId: z.string().uuid(),
    owner: z
      .object({
        userId: z.string().min(1),
        workspaceId: z.string().min(1),
      })
      .strict(),
    question: z.string().min(10).max(2_000),
    config: researchGraphConfigSchema,
  })
  .strict();

const lastValue = (fallback) => ({
  reducer: (current, update) => (update === undefined ? current : update),
  default: () => fallback,
});

const mergeBy = (key) => ({
  reducer: (current = [], update = []) => {
    const merged = new Map(current.map((item) => [item[key], item]));
    for (const item of update) {
      if (!item?.[key]) continue;
      merged.set(item[key], { ...(merged.get(item[key]) ?? {}), ...item });
    }
    return [...merged.values()];
  },
  default: () => [],
});

const uniqueList = {
  reducer: (current = [], update = []) => [...new Set([...current, ...update])],
  default: () => [],
};

export const ResearchState = Annotation.Root({
  taskId: Annotation(lastValue("")),
  threadId: Annotation(lastValue("")),
  owner: Annotation(lastValue(null)),
  question: Annotation(lastValue("")),
  config: Annotation(lastValue(null)),
  plan: Annotation(uniqueList),
  queries: Annotation(uniqueList),
  iteration: Annotation(lastValue(0)),
  sources: Annotation(mergeBy("sourceId")),
  chunks: Annotation(mergeBy("chunkId")),
  graphEvidence: Annotation(lastValue(null)),
  evaluation: Annotation(lastValue(null)),
  verification: Annotation(lastValue(null)),
  approval: Annotation(lastValue(null)),
  report: Annotation(lastValue(null)),
  status: Annotation(lastValue("processing")),
  error: Annotation(lastValue(null)),
});
