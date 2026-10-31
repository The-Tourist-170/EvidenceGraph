import {
  Command,
  END,
  INTERRUPT,
  START,
  StateGraph,
  isInterrupted,
} from "@langchain/langgraph";
import { createMemoryCheckpointer } from "./checkpointer.js";
import {
  approvalNode,
  evaluateNode,
  insufficientNode,
  planNode,
  reportNode,
  retrieveNode,
  routeAfterApproval,
  routeAfterEvaluate,
  verifyNode,
} from "./nodes.js";
import { createRetrievalTools } from "./retrieval-tools.js";
import { ResearchState, graphInputSchema } from "./state.js";

export function createResearchGraph({
  llm,
  search,
  embeddings,
  reranker,
  vectorRepository,
  graphRepository,
  reportStore,
  checkpointer = createMemoryCheckpointer(),
  now = () => new Date(),
}) {
  const tools = createRetrievalTools({
    vectorRepository,
    embeddings,
    reranker,
    graphRepository,
    now,
  });
  return new StateGraph(ResearchState)
    .addNode("planStep", (state) => planNode(state, { llm }))
    .addNode("retrieveStep", (state) => retrieveNode(state, { tools, search }))
    .addNode("evaluateStep", (state) => evaluateNode(state))
    .addNode("verifyStep", (state) => verifyNode(state, { llm }))
    .addNode("approvalStep", (state) => approvalNode(state))
    .addNode("reportStep", (state) => reportNode(state, { llm, reportStore }))
    .addNode("insufficientStep", (state) => insufficientNode(state))
    .addEdge(START, "planStep")
    .addEdge("planStep", "retrieveStep")
    .addEdge("retrieveStep", "evaluateStep")
    .addConditionalEdges("evaluateStep", routeAfterEvaluate, {
      retrieve: "retrieveStep",
      verify: "verifyStep",
      insufficient: "insufficientStep",
    })
    .addEdge("verifyStep", "approvalStep")
    .addConditionalEdges("approvalStep", routeAfterApproval, {
      retrieve: "retrieveStep",
      report: "reportStep",
    })
    .addEdge("reportStep", END)
    .addEdge("insufficientStep", END)
    .compile({ checkpointer });
}

export async function invokeResearchGraph({
  graph,
  input,
  threadId,
  resume,
  signal,
  onProgress,
  recursionLimit = 25,
}) {
  const validated = graphInputSchema.parse(input);
  const config = {
    configurable: {
      thread_id: threadId ?? validated.threadId,
      ...(onProgress ? { onProgress } : {}),
    },
    recursionLimit,
    ...(signal ? { signal } : {}),
  };
  const state = resume
    ? await graph.invoke(new Command({ resume }), config)
    : await graph.invoke(validated, config);
  if (isInterrupted(state)) {
    const interrupts = state[INTERRUPT] ?? state.__interrupt__ ?? [];
    return {
      interrupted: true,
      interrupt: interrupts[0]?.value ?? null,
      state,
    };
  }
  return { interrupted: false, state };
}
