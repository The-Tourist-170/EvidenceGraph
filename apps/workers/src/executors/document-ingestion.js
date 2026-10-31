import { createHash } from "node:crypto";
import { UnrecoverableError } from "bullmq";
import { chunkDocumentText, extractDocument } from "../extractors/document.js";

export async function executeDocumentIngestion(
  job,
  context,
  { objectStorage, persistence, graphRepository },
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
    message: "The document is ready for Phase 5 embeddings and indexing.",
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
