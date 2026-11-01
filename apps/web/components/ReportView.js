"use client";

import { useEffect, useMemo, useState } from "react";
import { ApiClientError, api } from "../lib/api.js";

function CitationChip({ sourceId, sourcesById, onActivate }) {
  const source = sourcesById.get(sourceId);
  return (
    <button
      type="button"
      onClick={() => onActivate(sourceId)}
      className="min-h-11 rounded-md border border-[#71343d] bg-[#32181d] px-3 py-2 text-left text-xs font-medium leading-4 text-[#ff969c] hover:bg-[#422027]"
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
      <section className="rounded-lg border border-[#71343d] bg-[#32181d] p-4">
        <p role="alert" className="text-sm text-[var(--danger)]">
          {error}
        </p>
        <button
          type="button"
          onClick={onClose}
          className="mt-3 text-sm text-[var(--ink-soft)] underline"
        >
          Back to task
        </button>
      </section>
    );
  }
  if (!report) {
    return <p className="text-sm text-[var(--muted)]">Loading report…</p>;
  }

  const body = report.body ?? {};

  return (
    <article className="flex flex-col gap-5 rounded-lg border border-[var(--line-soft)] bg-[var(--surface)] p-5">
      <header className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-wide text-[var(--muted)]">
            Revision {report.currentRevision}
          </p>
          <h2 className="text-xl font-semibold text-[var(--ink)]">
            {report.title}
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-[var(--line)] px-3 py-1.5 text-sm text-[var(--ink-soft)] hover:bg-[var(--surface-raised)]"
        >
          Back
        </button>
      </header>

      <p className="text-sm leading-6 text-[var(--ink-soft)]">{body.summary}</p>

      {(body.sections ?? []).map((section) => (
        <section key={section.heading} className="flex flex-col gap-2">
          <h3 className="text-base font-semibold text-[var(--ink)]">
            {section.heading}
          </h3>
          <p className="whitespace-pre-wrap text-sm leading-6 text-[var(--ink-soft)]">
            {section.body}
          </p>
        </section>
      ))}

      {(body.claims ?? []).length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="text-base font-semibold text-[var(--ink)]">
            Evidence-backed claims
          </h3>
          <ul className="flex flex-col gap-2">
            {body.claims.map((claim) => (
              <li
                key={claim.text}
                className="flex flex-wrap items-center gap-2 text-sm text-[var(--ink-soft)]"
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
          <h3 className="text-base font-semibold text-[var(--ink)]">
            Limitations and uncertainty
          </h3>
          <ul className="list-disc pl-5 text-sm text-[var(--ink-soft)]">
            {body.limitations.map((limitation) => (
              <li key={limitation}>{limitation}</li>
            ))}
          </ul>
        </section>
      )}

      <section className="flex flex-col gap-2">
        <h3 className="text-base font-semibold text-[var(--ink)]">Sources</h3>
        {(body.sources ?? []).length === 0 ? (
          <p className="text-sm text-[var(--muted)]">
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
                  className="rounded-md border border-[var(--line-soft)] bg-[#120d0f] px-3 py-2 text-sm"
                >
                  <span className="font-medium text-[var(--ink-soft)]">
                    {source.title}
                  </span>
                  <span className="ml-2 text-xs uppercase text-[var(--quiet)]">
                    {source.provenance?.provider}/{source.provenance?.tool}
                  </span>
                  <div className="mt-1 break-all text-xs text-[var(--muted)]">
                    {external ? (
                      <a
                        href={source.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline hover:text-[var(--ink)]"
                      >
                        {source.url}
                      </a>
                    ) : (
                      <span>{source.url}</span>
                    )}
                  </div>
                  {source.snippet && (
                    <p className="mt-1 text-xs text-[var(--muted)]">
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
