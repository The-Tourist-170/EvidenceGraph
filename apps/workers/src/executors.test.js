import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { UnrecoverableError } from "bullmq";
import { executeDocumentIngestion } from "./executors/document-ingestion.js";
import { executeResearch } from "./executors/research.js";

function createContext() {
  const progress = [];
  return {
    progress,
    async throwIfCancelled() {},
    async waitForStage() {},
    async reportProgress(value) {
      progress.push(value);
    },
  };
}

describe("worker executors", () => {
  test("runs a deterministic multi-stage synthetic research workflow", async () => {
    const context = createContext();
    const result = await executeResearch(
      { data: { question: "How do trees affect heat?" } },
      context,
    );

    expect(result).toEqual({
      summary: "Synthetic research result for: How do trees affect heat?",
      claims: [],
      sourceIds: [],
      synthetic: true,
    });
    expect(context.progress.map(({ stage }) => stage)).toEqual([
      "planning",
      "evidence-review",
      "synthesis",
    ]);
  });

  test("reads and verifies a MinIO object without extracting text", async () => {
    const bytes = new TextEncoder().encode("Phase 3 fixture");
    const context = createContext();
    let requested;
    const result = await executeDocumentIngestion(
      {
        data: {
          documentId: "00000000-0000-4000-8000-000000000001",
          filename: "fixture.txt",
          objectKey: "documents/00000000-0000-4000-8000-000000000001",
          size: bytes.byteLength,
        },
      },
      context,
      {
        async getObject(key, options) {
          requested = { key, options };
          return { bytes, mediaType: "text/plain" };
        },
      },
    );

    expect(requested.key).toBe(
      "documents/00000000-0000-4000-8000-000000000001",
    );
    expect(result).toEqual({
      documentId: "00000000-0000-4000-8000-000000000001",
      bytesProcessed: bytes.byteLength,
      digest: createHash("sha256").update(bytes).digest("hex"),
      extractedText: false,
    });
    expect(context.progress.at(-1).stage).toBe("ingestion-ready");
  });

  test("classifies object-size mismatches as non-retryable", async () => {
    const context = createContext();
    await expect(
      executeDocumentIngestion(
        {
          data: {
            documentId: "00000000-0000-4000-8000-000000000001",
            filename: "fixture.txt",
            objectKey: "documents/00000000-0000-4000-8000-000000000001",
            size: 2,
          },
        },
        context,
        {
          getObject: async () => ({
            bytes: new Uint8Array([1]),
            mediaType: "text/plain",
          }),
        },
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });
});
