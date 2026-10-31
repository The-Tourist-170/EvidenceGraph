import { MemorySaver } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

export function createMemoryCheckpointer() {
  return new MemorySaver();
}

export async function createPostgresCheckpointer({
  connectionString,
  schema,
  setup = true,
} = {}) {
  if (!connectionString) {
    throw new Error(
      "A PostgreSQL connection string is required for LangGraph checkpoints.",
    );
  }
  const checkpointer = PostgresSaver.fromConnString(
    connectionString,
    schema ? { schema } : undefined,
  );
  if (setup) await checkpointer.setup();
  return checkpointer;
}
