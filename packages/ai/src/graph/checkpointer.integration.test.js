import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, test } from "bun:test";
import {
  Annotation,
  Command,
  END,
  START,
  StateGraph,
  interrupt,
  isInterrupted,
} from "@langchain/langgraph";
import postgres from "postgres";
import { getDatabaseConfig } from "@evidencegraph/config";
import { createPostgresCheckpointer } from "./checkpointer.js";

const integrationEnabled = process.env.RUN_PHASE6_INTEGRATION === "1";
const integrationTest = integrationEnabled ? test : test.skip;
const threadId = randomUUID();
const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://evidencegraph:local-dev-password@localhost:5433/evidencegraph";

const State = Annotation.Root({
  value: Annotation({
    reducer: (_current, update) => (update === undefined ? _current : update),
    default: () => 0,
  }),
});

describe("Phase 6 PostgreSQL checkpoints", () => {
  integrationTest(
    "persists an interrupt and resumes from the same thread",
    async () => {
      const config = getDatabaseConfig({
        ...process.env,
        NODE_ENV: "test",
        DATABASE_URL: databaseUrl,
      });
      const checkpointer = await createPostgresCheckpointer({
        connectionString: config.url,
      });
      const graph = new StateGraph(State)
        .addNode("pause", async () => {
          const decision = interrupt({ question: "Approve this checkpoint?" });
          return { value: decision.approved ? 1 : 0 };
        })
        .addEdge(START, "pause")
        .addEdge("pause", END)
        .compile({ checkpointer });

      const first = await graph.invoke(
        { value: 0 },
        { configurable: { thread_id: threadId } },
      );
      expect(isInterrupted(first)).toBe(true);

      const second = await graph.invoke(
        new Command({ resume: { approved: true } }),
        { configurable: { thread_id: threadId } },
      );
      expect(second.value).toBe(1);
    },
    120_000,
  );
});

afterAll(async () => {
  if (!integrationEnabled) return;
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    for (const table of [
      "checkpoint_writes",
      "checkpoint_blobs",
      "checkpoints",
    ]) {
      await sql.unsafe(`delete from ${table} where thread_id = $1`, [threadId]);
    }
  } catch {
    // Best-effort cleanup for local integration runs.
  } finally {
    await sql.end({ timeout: 5 });
  }
});
