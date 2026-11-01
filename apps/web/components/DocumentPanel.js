"use client";

import { useState } from "react";
import { ApiClientError, api, uploadDocument } from "../lib/api.js";

function stageLabel(stage) {
  if (!stage) return "Waiting for document worker";
  return stage
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function formatBytes(bytes) {
  if (bytes < 1_000_000) return `${Math.max(1, Math.round(bytes / 1_000))} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

function UploadProgress({ filename, percent }) {
  return (
    <div
      className="panel-soft flex flex-col gap-3 p-3"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center gap-3">
        <span className="loader-ring" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-[var(--ink-soft)]">
            Sending {filename}
          </p>
          <p className="mt-0.5 font-mono text-[10px] text-[var(--muted)]">
            {percent}% · upload
          </p>
        </div>
      </div>
      <div
        className="progress-track"
        role="progressbar"
        aria-label="File upload"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <div className="progress-fill" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function DocumentRow({ document, onRemove }) {
  const progress = document.progress;
  const isActive =
    document.status === "queued" || document.status === "processing";
  const percent = progress?.percent ?? 0;
  const label =
    document.status === "queued"
      ? "Waiting in queue"
      : document.status === "processing"
        ? stageLabel(progress?.stage)
        : document.status === "completed"
          ? "Ready for research"
          : document.status;
  const tone =
    document.status === "failed"
      ? "text-[var(--danger)]"
      : document.status === "completed"
        ? "text-[var(--success)]"
        : isActive
          ? "text-[var(--signal-bright)]"
          : "text-[var(--muted)]";

  return (
    <li
      className="rounded-lg border border-[var(--line-soft)] bg-[var(--canvas-raised)] p-3"
      aria-busy={isActive}
    >
      <div className="flex items-start gap-3">
        <span
          className={`mt-1 grid h-11 w-11 shrink-0 place-items-center rounded-md border text-[11px] font-bold uppercase ${
            document.mediaType === "application/pdf"
              ? "border-[#74343e] bg-[#321a20] text-[#ff8c92]"
              : "border-[var(--line)] bg-[var(--surface)] text-[var(--ink-soft)]"
          }`}
          aria-hidden="true"
        >
          {document.mediaType === "application/pdf" ? "PDF" : "TXT"}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p
                className="truncate text-xs font-semibold text-[var(--ink-soft)]"
                title={document.filename}
              >
                {document.filename}
              </p>
              <p className="mt-1 flex items-center gap-1.5 text-[10px]">
                {isActive && (
                  <span
                    className="loader-ring h-3.5 w-3.5 border-[1.5px]"
                    aria-hidden="true"
                  />
                )}
                <span className={tone}>{label}</span>
              </p>
            </div>
            <button
              type="button"
              onClick={() => onRemove(document.id)}
              className="min-h-11 min-w-11 rounded-md px-2 text-xs text-[var(--quiet)] hover:bg-[#35191e] hover:text-[var(--danger)]"
              aria-label={`Delete ${document.filename}`}
              title="Delete document"
            >
              ×
            </button>
          </div>
          {isActive && (
            <div className="mt-2.5">
              <div
                className="progress-track"
                role="progressbar"
                aria-label={`Ingestion progress for ${document.filename}`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
              >
                {progress ? (
                  <div
                    className="progress-fill"
                    style={{ width: `${percent}%` }}
                  />
                ) : (
                  <div className="progress-fill progress-indeterminate" />
                )}
              </div>
              <p className="mt-1.5 text-[10px] leading-4 text-[var(--quiet)]">
                {progress?.message ??
                  "Worker will read, extract, chunk, and index this file."}
              </p>
            </div>
          )}
          {document.status === "completed" && progress?.message && (
            <p className="mt-1.5 text-[10px] leading-4 text-[var(--quiet)]">
              {progress.message}
            </p>
          )}
          {document.status === "failed" && document.error && (
            <p
              role="alert"
              className="mt-2 rounded-md border border-[#71343d] bg-[#32181d] px-2 py-1.5 text-[10px] leading-4 text-[#ff969c]"
            >
              {document.error}
            </p>
          )}
          <p className="mt-2 font-mono text-[9px] text-[var(--quiet)]">
            {formatBytes(document.size)} · {document.status.toUpperCase()}
          </p>
        </div>
      </div>
    </li>
  );
}

export default function DocumentPanel({ documents, onChanged, onUploaded }) {
  const [upload, setUpload] = useState(null);
  const [error, setError] = useState(null);

  async function onUpload(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setUpload({ filename: file.name, percent: 0 });
    setError(null);
    try {
      const document = await uploadDocument(file, {
        onProgress: ({ percent }) =>
          setUpload((current) => (current ? { ...current, percent } : current)),
      });
      onUploaded?.(document);
      await onChanged?.();
    } catch (caught) {
      setError(
        caught instanceof ApiClientError ? caught.message : String(caught),
      );
    } finally {
      setUpload(null);
      event.target.value = "";
    }
  }

  async function remove(id) {
    setError(null);
    try {
      await api.deleteDocument(id);
      await onChanged?.();
    } catch (caught) {
      setError(
        caught instanceof ApiClientError ? caught.message : String(caught),
      );
    }
  }

  return (
    <section className="flex flex-col gap-3" aria-labelledby="documents-title">
      <div className="flex items-end justify-between gap-3">
        <div>
          <p className="eyebrow">
            Knowledge base / {String(documents.length).padStart(2, "0")}
          </p>
          <h2
            id="documents-title"
            className="mt-1 text-base font-semibold text-[var(--ink)]"
          >
            Documents
          </h2>
        </div>
        {documents.some(
          (document) =>
            document.status === "processing" || document.status === "queued",
        ) && (
          <span className="font-mono text-[9px] uppercase tracking-[0.1em] text-[var(--signal-bright)]">
            Indexing
          </span>
        )}
      </div>

      <label className="group flex min-h-16 cursor-pointer items-center gap-3 rounded-lg border border-dashed border-[#63333a] bg-[#1c1114] px-3 py-3 transition-colors hover:border-[#a74853] hover:bg-[#241316] focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--focus)]">
        <span
          className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-[#71343d] bg-[#35191e] font-mono text-lg text-[#ff858c]"
          aria-hidden="true"
        >
          ↑
        </span>
        <span className="min-w-0">
          <span className="block text-xs font-semibold text-[var(--ink-soft)]">
            Add a source file
          </span>
          <span className="mt-0.5 block text-[10px] text-[var(--quiet)]">
            PDF, Markdown, or text · max 5 MB
          </span>
        </span>
        <input
          type="file"
          accept=".pdf,.md,.markdown,.txt,text/plain,text/markdown,application/pdf"
          onChange={onUpload}
          disabled={Boolean(upload)}
          className="sr-only"
        />
      </label>

      {upload && (
        <UploadProgress filename={upload.filename} percent={upload.percent} />
      )}
      {error && (
        <p
          role="alert"
          className="rounded-md border border-[#71343d] bg-[#32181d] px-3 py-2 text-xs text-[#ff969c]"
        >
          {error}
        </p>
      )}

      {documents.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--line-soft)] px-4 py-5">
          <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--quiet)]">
            No source files
          </p>
          <p className="mt-1.5 text-xs leading-5 text-[var(--muted)]">
            Uploaded documents become searchable evidence after extraction and
            indexing.
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {documents.map((document) => (
            <DocumentRow
              key={document.id}
              document={document}
              onRemove={remove}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
