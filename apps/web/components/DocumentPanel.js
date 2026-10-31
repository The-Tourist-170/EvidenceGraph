"use client";

import { useState } from "react";
import { ApiClientError, api, uploadDocument } from "../lib/api.js";

export default function DocumentPanel({ documents, onChanged }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);

  async function onUpload(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setPending(true);
    setError(null);
    try {
      await uploadDocument(file);
      onChanged?.();
    } catch (caught) {
      setError(
        caught instanceof ApiClientError ? caught.message : String(caught),
      );
    } finally {
      setPending(false);
      event.target.value = "";
    }
  }

  async function remove(id) {
    setError(null);
    try {
      await api.deleteDocument(id);
      onChanged?.();
    } catch (caught) {
      setError(
        caught instanceof ApiClientError ? caught.message : String(caught),
      );
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
        Documents
      </h2>
      <label className="flex cursor-pointer items-center justify-center rounded-md border border-dashed border-slate-300 px-4 py-4 text-sm text-slate-600 hover:border-slate-500">
        {pending ? "Uploading…" : "Upload a PDF, Markdown, or text file"}
        <input
          type="file"
          accept=".pdf,.md,.markdown,.txt,text/plain,text/markdown,application/pdf"
          onChange={onUpload}
          disabled={pending}
          className="hidden"
        />
      </label>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      {documents.length === 0 ? (
        <p className="text-sm text-slate-500">
          No documents yet. Uploaded files are chunked, embedded, and indexed
          for retrieval.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {documents.map((document) => (
            <li
              key={document.id}
              className="flex items-center justify-between gap-2 rounded-md border border-slate-200 bg-white px-3 py-2"
            >
              <span className="truncate text-sm text-slate-800">
                {document.filename}
              </span>
              <span className="flex items-center gap-2">
                <span className="text-xs text-slate-500">
                  {document.status}
                </span>
                <button
                  type="button"
                  onClick={() => remove(document.id)}
                  className="text-xs text-red-600 underline hover:text-red-800"
                >
                  Delete
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
