import { createHash } from "node:crypto";
import { UnrecoverableError } from "bullmq";
import { IntegrationError } from "@evidencegraph/ai";
import { chunkDocumentText, extractDocument } from "../extractors/document.js";

export async function executeDocumentIngestion(
  job,
  context,
  { objectStorage, persistence, graphRepository, embeddings },
) {
  await context.reportProgress({
    percent: 10,
    stage: "object-read",
    message: "Reading the uploaded object.",
  });
  const object = await objectStorage.getObject(job.data.objectKey, {
    signal: context.signal,
  });
  await context.throwIfCancelled();
  if (object.bytes.byteLength !== job.data.size) {
    throw new UnrecoverableError("DOCUMENT_SIZE_MISMATCH");
  }
  const digest = createHash("sha256").update(object.bytes).digest("hex");
  await context.reportProgress({
    percent: 35,
    stage: "text-extraction",
    message: "Extracting supported document text.",
  });
  const extracted = await extractDocument({
    bytes: object.bytes,
    mediaType: job.data.mediaType,
  });
  await context.throwIfCancelled();
  const chunks = chunkDocumentText(job.data.documentId, extracted.text);
  await context.reportProgress({
    percent: 65,
    stage: "chunk-persistence",
    message: "Saving normalized document chunks.",
  });
  await persistence.saveDocumentChunks(job.data.documentId, chunks);
  await context.throwIfCancelled();
  if (embeddings) {
    await context.reportProgress({
      percent: 80,
      stage: "embeddings",
      message: "Embedding document chunks.",
    });
    try {
      const vectors = await embeddings.embedDocuments(
        chunks.map((chunk) => chunk.content),
        { signal: context.signal },
      );
      if (vectors.length !== chunks.length) {
        throw new UnrecoverableError("DOCUMENT_EMBEDDING_COUNT_MISMATCH");
      }
      for (const vector of vectors) {
        if (!Array.isArray(vector) || vector.length !== embeddings.dimensions) {
          throw new UnrecoverableError("DOCUMENT_EMBEDDING_DIMENSION_MISMATCH");
        }
      }
      await persistence.vectorRepository.upsertPoints(
        chunks.map((chunk, index) => ({
          id: chunk.id,
          dense: vectors[index],
          payload: {
            workspaceId: job.data.owner.workspaceId,
            userId: job.data.owner.userId,
            documentId: job.data.documentId,
            chunkId: chunk.id,
            content: chunk.content,
            metadata: chunk.metadata,
          },
        })),
      );
    } catch (error) {
      if (error instanceof IntegrationError && !error.retryable) {
        throw new UnrecoverableError(error.code);
      }
      throw error;
    }
  }
  await context.throwIfCancelled();
  await graphRepository.upsertDocument({
    id: job.data.documentId,
    userId: job.data.owner.userId,
    workspaceId: job.data.owner.workspaceId,
    filename: job.data.filename,
    mediaType: job.data.mediaType,
  });
  await context.reportProgress({
    percent: 100,
    stage: "ingestion-ready",
    message: embeddings
      ? "Document text and vectors are indexed for research."
      : "Document text and chunks are ready; vector indexing is not configured.",
  });
  return {
    documentId: job.data.documentId,
    bytesProcessed: object.bytes.byteLength,
    digest,
    pageCount: extracted.pageCount,
    chunkCount: chunks.length,
    extractedText: true,
  };
}
