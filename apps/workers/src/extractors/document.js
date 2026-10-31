import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { UnrecoverableError } from "bullmq";

function normalizeText(value) {
  return value
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .replaceAll("\u0000", "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function extractPdf(bytes) {
  const pdfjsEntry = import.meta.resolve("pdfjs-dist/legacy/build/pdf.mjs");
  const standardFontDataUrl = `${fileURLToPath(new URL("../../standard_fonts/", pdfjsEntry))}/`;
  const loadingTask = getDocument({
    data: bytes,
    standardFontDataUrl,
    disableFontFace: true,
    isEvalSupported: false,
    useWorkerFetch: false,
  });
  const document = await loadingTask.promise;
  const pages = [];
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = normalizeText(
        content.items
          .filter((item) => typeof item.str === "string")
          .map((item) => item.str)
          .join(" "),
      );
      if (text) pages.push({ page: pageNumber, text });
      page.cleanup();
    }
  } finally {
    await loadingTask.destroy();
  }
  return {
    text: normalizeText(pages.map((page) => page.text).join("\n\n")),
    pageCount: document.numPages,
    pages,
  };
}

export async function extractDocument({ bytes, mediaType }) {
  let extracted;
  if (mediaType === "application/pdf") {
    try {
      extracted = await extractPdf(bytes);
    } catch {
      throw new UnrecoverableError("DOCUMENT_PDF_EXTRACTION_FAILED");
    }
  } else if (
    ["text/plain", "text/markdown", "text/x-markdown"].includes(mediaType)
  ) {
    try {
      const text = normalizeText(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
      extracted = { text, pageCount: 1, pages: [{ page: 1, text }] };
    } catch {
      throw new UnrecoverableError("DOCUMENT_TEXT_DECODING_FAILED");
    }
  } else {
    throw new UnrecoverableError("DOCUMENT_MEDIA_TYPE_UNSUPPORTED");
  }

  if (!extracted.text) throw new UnrecoverableError("DOCUMENT_TEXT_EMPTY");
  return extracted;
}

function stableUuid(value) {
  const bytes = createHash("sha256").update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function chunkDocumentText(
  documentId,
  text,
  { chunkSize = 1_200, overlap = 120 } = {},
) {
  if (!Number.isInteger(chunkSize) || chunkSize < 100) {
    throw new RangeError("chunkSize must be an integer of at least 100.");
  }
  if (!Number.isInteger(overlap) || overlap < 0 || overlap >= chunkSize) {
    throw new RangeError(
      "overlap must be a non-negative integer smaller than chunkSize.",
    );
  }
  const normalized = normalizeText(text);
  const chunks = [];
  let start = 0;
  while (start < normalized.length) {
    let end = Math.min(start + chunkSize, normalized.length);
    if (end < normalized.length) {
      const boundary = normalized.lastIndexOf(" ", end);
      if (boundary > start + Math.floor(chunkSize * 0.6)) end = boundary;
    }
    const content = normalized.slice(start, end).trim();
    if (content) {
      const index = chunks.length;
      chunks.push({
        id: stableUuid(`${documentId}:${index}:${content}`),
        index,
        content,
        metadata: { startOffset: start, endOffset: end },
      });
    }
    if (end >= normalized.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}
