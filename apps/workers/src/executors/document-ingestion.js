import { createHash } from "node:crypto";
import { UnrecoverableError } from "bullmq";

export async function executeDocumentIngestion(job, context, objectStorage) {
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
    percent: 70,
    stage: "metadata-check",
    message: "Verifying document metadata.",
  });
  await context.waitForStage();
  await context.reportProgress({
    percent: 100,
    stage: "ingestion-ready",
    message: "The document is ready for Phase 4 extraction.",
  });
  return {
    documentId: job.data.documentId,
    bytesProcessed: object.bytes.byteLength,
    digest,
    extractedText: false,
  };
}
