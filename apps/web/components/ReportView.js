"use client";

import { useEffect, useMemo, useState } from "react";
import { ApiClientError, api } from "../lib/api.js";

function CitationChip({ sourceId, sourcesById, onActivate }) {
  const source = sourcesById.get(sourceId);
  return (
    <button
      type="button"
      onClick={() => onActivate(sourceId)}
      className="rounded-full border border-teal-300 bg-teal-50 px-2 py-0.5 text-xs font-medium text-teal-800 hover:bg-teal-100"
      title={source?.title ?? sourceId}
    >
      {source ? source.title.slice(0, 40) : sourceId.slice(0, 12)}
    </button>
  );
}

export default function ReportView({ taskId, onClose }) {
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getReport(taskId)
      .then((value) => {
        if (!cancelled) setReport(value);
      })
      .catch((caught) => {
        if (!cancelled) {
          setError(
            caught instanceof ApiClientError ? caught.message : String(caught),
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  const sourcesById = useMemo(() => {
    const map = new Map();
    for (const source of report?.body?.sources ?? []) {
      map.set(source.sourceId, source);
    }
    return map;
  }, [report]);

  function activate(sourceId) {
    const element = document.getElementById(`source-${sourceId}`);
    element?.scrollIntoView({ behavior: "smooth", block: "center" });
    element?.focus?.();
  }

  if (error) {
    return (
      <section className="rounded-lg border border-red-200 bg-red-50 p-4">
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
        <button
          type="button"
          onClick={onClose}
          className="mt-3 text-sm text-slate-700 underline"
        >
          Back to task
        </button>
      </section>
    );
  }
  if (!report) {
    return <p className="text-sm text-slate-500">Loading report…</p>;
  }

  const body = report.body ?? {};

  return (
    <article className="flex flex-col gap-5 rounded-lg border border-slate-200 bg-white p-5">
      <header className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-500">
            Revision {report.currentRevision}
          </p>
          <h2 className="text-xl font-semibold text-slate-900">
            {report.title}
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100"
        >
          Back
        </button>
      </header>

      <p className="text-sm leading-6 text-slate-700">{body.summary}</p>

      {(body.sections ?? []).map((section) => (
        <section key={section.heading} className="flex flex-col gap-2">
          <h3 className="text-base font-semibold text-slate-900">
            {section.heading}
          </h3>
          <p className="whitespace-pre-wrap text-sm leading-6 text-slate-700">
            {section.body}
          </p>
        </section>
      ))}

      {(body.claims ?? []).length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="text-base font-semibold text-slate-900">
            Evidence-backed claims
          </h3>
          <ul className="flex flex-col gap-2">
            {body.claims.map((claim) => (
              <li
                key={claim.text}
                className="flex flex-wrap items-center gap-2 text-sm text-slate-700"
              >
                <span>{claim.text}</span>
                <span className="flex flex-wrap gap-1">
                  {claim.sourceIds.map((sourceId) => (
                    <CitationChip
                      key={sourceId}
                      sourceId={sourceId}
                      sourcesById={sourcesById}
                      onActivate={activate}
                    />
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {(body.limitations ?? []).length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="text-base font-semibold text-slate-900">
            Limitations and uncertainty
          </h3>
          <ul className="list-disc pl-5 text-sm text-slate-700">
            {body.limitations.map((limitation) => (
              <li key={limitation}>{limitation}</li>
            ))}
          </ul>
        </section>
      )}

      <section className="flex flex-col gap-2">
        <h3 className="text-base font-semibold text-slate-900">Sources</h3>
        {(body.sources ?? []).length === 0 ? (
          <p className="text-sm text-slate-500">
            No external sources were attached to this report.
          </p>
        ) : (
          <ol className="flex flex-col gap-2">
            {body.sources.map((source) => {
              const external = source.url?.startsWith("http");
              return (
                <li
                  key={source.sourceId}
                  id={`source-${source.sourceId}`}
                  tabIndex={-1}
                  className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm"
                >
                  <span className="font-medium text-slate-800">
                    {source.title}
                  </span>
                  <span className="ml-2 text-xs uppercase text-slate-400">
                    {source.provenance?.provider}/{source.provenance?.tool}
                  </span>
                  <div className="mt-1 break-all text-xs text-slate-600">
                    {external ? (
                      <a
                        href={source.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline hover:text-slate-900"
                      >
                        {source.url}
                      </a>
                    ) : (
                      <span>{source.url}</span>
                    )}
                  </div>
                  {source.snippet && (
                    <p className="mt-1 text-xs text-slate-500">
                      {source.snippet.slice(0, 200)}
                    </p>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </article>
  );
}
