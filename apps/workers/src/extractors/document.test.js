import { PDFDocument } from "pdf-lib";
import { describe, expect, test } from "bun:test";
import { chunkDocumentText, extractDocument } from "./document.js";

describe("document extraction and chunking", () => {
  test("normalizes Markdown and creates stable overlapping chunk IDs", () => {
    const text = `Heading\r\n\r\n${"Evidence-backed research. ".repeat(20)}`;
    const first = chunkDocumentText(
      "00000000-0000-4000-8000-000000000001",
      text,
      { chunkSize: 120, overlap: 20 },
    );
    const second = chunkDocumentText(
      "00000000-0000-4000-8000-000000000001",
      text,
      { chunkSize: 120, overlap: 20 },
    );

    expect(first.length).toBeGreaterThan(1);
    expect(first.map(({ id }) => id)).toEqual(second.map(({ id }) => id));
    expect(first[0].content).toContain("Heading");
  });

  test("extracts text from a generated PDF with page provenance", async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage();
    page.drawText("EvidenceGraph PDF extraction fixture.", { x: 40, y: 740 });
    const bytes = new Uint8Array(await pdf.save());

    const extracted = await extractDocument({
      bytes,
      mediaType: "application/pdf",
    });

    expect(extracted.text).toContain("EvidenceGraph PDF extraction fixture.");
    expect(extracted.pageCount).toBe(1);
    expect(extracted.pages[0].page).toBe(1);
  });

  test("rejects unsupported or empty document text", async () => {
    await expect(
      extractDocument({ bytes: new Uint8Array([1]), mediaType: "image/png" }),
    ).rejects.toMatchObject({ message: "DOCUMENT_MEDIA_TYPE_UNSUPPORTED" });
    await expect(
      extractDocument({ bytes: new Uint8Array(), mediaType: "text/plain" }),
    ).rejects.toMatchObject({ message: "DOCUMENT_TEXT_EMPTY" });
  });
});
