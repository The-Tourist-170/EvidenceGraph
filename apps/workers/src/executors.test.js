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

  test("extracts text, persists stable chunks, and associates the document graph", async () => {
    const bytes = new TextEncoder().encode("Phase 3 fixture");
    const context = createContext();
    let requested;
    let savedChunks;
    let graphDocument;
    const documentId = "00000000-0000-4000-8000-000000000001";
    const result = await executeDocumentIngestion(
      {
        data: {
          documentId,
          filename: "fixture.txt",
          objectKey: `documents/${documentId}`,
          mediaType: "text/plain",
          size: bytes.byteLength,
          owner: { userId: "user-a", workspaceId: "workspace-a" },
        },
      },
      context,
      {
        objectStorage: {
          async getObject(key, options) {
            requested = { key, options };
            return { bytes, mediaType: "text/plain" };
          },
        },
        persistence: {
          async saveDocumentChunks(id, chunks) {
            savedChunks = { id, chunks };
          },
        },
        graphRepository: {
          async upsertDocument(document) {
            graphDocument = document;
          },
        },
      },
    );

    expect(requested.key).toBe(`documents/${documentId}`);
    expect(result).toMatchObject({
      documentId,
      bytesProcessed: bytes.byteLength,
      pageCount: 1,
      chunkCount: 1,
      extractedText: true,
    });
    expect(result.digest).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    expect(savedChunks.id).toBe(documentId);
    expect(savedChunks.chunks[0].content).toBe("Phase 3 fixture");
    expect(graphDocument).toMatchObject({
      id: documentId,
      userId: "user-a",
      workspaceId: "workspace-a",
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
          objectStorage: {
            getObject: async () => ({
              bytes: new Uint8Array([1]),
              mediaType: "text/plain",
            }),
          },
          persistence: { saveDocumentChunks: async () => {} },
          graphRepository: { upsertDocument: async () => {} },
        },
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });
});
