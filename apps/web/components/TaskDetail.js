"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiClientError, api } from "../lib/api.js";
import { streamEvents } from "../lib/events.js";

const terminalStatuses = new Set([
  "completed",
  "failed",
  "cancelled",
  "awaiting_approval",
]);

function stageLabel(stage) {
  if (!stage) return "Working…";
  return stage
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function formatEventTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--/--/-- | --:--";
  const pad = (number) => String(number).padStart(2, "0");
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${String(date.getFullYear()).slice(-2)} | ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function eventTone(type) {
  if (type.includes("failed")) return "text-[var(--danger)]";
  if (type.includes("completed")) return "text-[var(--success)]";
  if (type.includes("approval")) return "text-[var(--warning)]";
  if (type.includes("progress")) return "text-[var(--signal-bright)]";
  return "text-[var(--muted)]";
}

export default function TaskDetail({ task, onChanged, onOpenReport }) {
  const [events, setEvents] = useState([]);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(null);
  const [approvalFeedback, setApprovalFeedback] = useState("");
  const [pendingAction, setPendingAction] = useState(null);
  const controllerRef = useRef(null);

  const stopped = terminalStatuses.has(task.status);

  const connect = useCallback((id, isStopped) => {
    controllerRef.current?.abort();
    if (isStopped) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    streamEvents({
      url: api.eventsUrl(id),
      signal: controller.signal,
      onEvent: ({ data }) => {
        if (!data) return;
        setEvents((current) => [...current.slice(-49), data]);
        if (data.type === "research.progress") setProgress(data.data);
      },
      onEnd: () => {},
    }).catch((caught) => {
      if (caught?.name === "AbortError") return;
      setError(caught.message);
    });
  }, []);

  useEffect(() => {
    setEvents([]);
    setProgress(null);
    setError(null);
    connect(task.id, stopped);
    return () => controllerRef.current?.abort();
  }, [task.id, stopped, connect]);

  useEffect(() => {
    if (!stopped) return;
    const status = async () => {
      try {
        const next = await api.getTask(task.id);
        onChanged?.(next);
      } catch {
        // Keep the last known state if a refresh races task deletion.
      }
    };
    status();
  }, [stopped, task.id, onChanged]);

  async function act(name, run) {
    setPendingAction(name);
    setError(null);
    try {
      const next = await run();
      onChanged?.(next);
    } catch (caught) {
      setError(
        caught instanceof ApiClientError ? caught.message : String(caught),
      );
    } finally {
      setPendingAction(null);
    }
  }

  const canApprove = task.status === "awaiting_approval";

  return (
    <section
      aria-live="polite"
      className="panel flex flex-col gap-4 overflow-hidden p-4 sm:p-5"
    >
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-[var(--ink)]">
            {task.question}
          </h2>
          <p
            className={`mt-1 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.12em] ${eventTone(`task.${task.status}`)}`}
          >
            <span className="status-dot" />
            {task.status.replaceAll("_", " ")}
            {task.executionId ? ` · ${task.executionId.slice(0, 8)}` : ""}
          </p>
        </div>
        <div className="flex gap-2">
          {!stopped && task.status !== "awaiting_approval" && (
            <button
              type="button"
              disabled={pendingAction === "cancel"}
              onClick={() => act("cancel", () => api.cancelTask(task.id))}
              className="button-secondary border-[#71343d] text-[#ff969c] hover:bg-[#35191e] disabled:opacity-50"
            >
              Cancel
            </button>
          )}
          {task.status === "failed" && (
            <button
              type="button"
              disabled={pendingAction === "retry"}
              onClick={() => act("retry", () => api.retryTask(task.id))}
              className="button-secondary disabled:opacity-50"
            >
              Retry
            </button>
          )}
          {task.status === "completed" && (
            <button
              type="button"
              onClick={() => onOpenReport?.(task.id)}
              className="button-primary min-h-9 px-3 py-1.5"
            >
              View report
            </button>
          )}
        </div>
      </header>

      {progress && (
        <div className="panel-soft p-4">
          <div className="flex items-center justify-between text-sm text-[var(--ink-soft)]">
            <span>{stageLabel(progress.stage)}</span>
            <span>{progress.percent}%</span>
          </div>
          <div
            className="progress-track mt-3 w-full"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress.percent}
          >
            <div
              className="progress-fill"
              style={{ width: `${progress.percent}%` }}
            />
          </div>
          <p className="mt-2 text-xs text-[var(--muted)]">{progress.message}</p>
        </div>
      )}

      {canApprove && (
        <form
          className="flex flex-col gap-3 rounded-lg border border-[#75502e] bg-[#281d15] p-4"
          onSubmit={(event) => {
            event.preventDefault();
            act("approve", () =>
              api.approveTask(task.id, {
                approved: true,
                ...(approvalFeedback.trim()
                  ? { feedback: approvalFeedback.trim() }
                  : {}),
              }),
            );
          }}
        >
          <p className="text-sm font-semibold text-[#f1c98d]">
            The research plan is waiting for your approval.
          </p>
          <label className="flex flex-col gap-2 text-xs font-semibold text-[#e5bd82]">
            Feedback or redirection (optional)
            <input
              value={approvalFeedback}
              onChange={(event) => setApprovalFeedback(event.target.value)}
              placeholder="Focus on surface temperature measurements."
              className="field border-[#75502e] bg-[#170f0b] text-sm"
            />
          </label>
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={pendingAction === "approve"}
              className="button-primary border-[#b17a3e] bg-[linear-gradient(135deg,#a66c32,#75451f)] disabled:opacity-50"
            >
              Approve plan
            </button>
            <button
              type="button"
              disabled={pendingAction === "reject"}
              onClick={() =>
                act("reject", () =>
                  api.approveTask(task.id, {
                    approved: false,
                    feedback:
                      approvalFeedback.trim() ||
                      "Please try a different angle.",
                  }),
                )
              }
              className="button-secondary border-[#75502e] text-[#e5bd82] hover:bg-[#332416] disabled:opacity-50"
            >
              Reject and redirect
            </button>
          </div>
        </form>
      )}

      {events.length > 0 && (
        <div className="flex flex-col gap-2 border-t border-[var(--line-soft)] pt-4">
          <div className="flex items-center justify-between">
            <h3 className="eyebrow">Run activity</h3>
            <span className="font-mono text-[9px] text-[var(--quiet)]">
              {events.length} events
            </span>
          </div>
          <ol className="max-h-56 overflow-y-auto rounded-lg border border-[var(--line-soft)] bg-[#100c0d] p-2">
            {events.map((event, index) => (
              <li
                key={`${event.id ?? index}`}
                className="grid grid-cols-[118px_1fr] gap-3 border-b border-white/[0.035] px-2 py-2 last:border-b-0"
              >
                <time className="font-mono text-[9px] tabular-nums text-[var(--quiet)]">
                  {formatEventTime(event.timestamp)}
                </time>
                <div className="min-w-0">
                  <span
                    className={`font-mono text-[10px] font-bold uppercase tracking-[0.06em] ${eventTone(event.type)}`}
                  >
                    {event.type}
                  </span>
                  {event.type === "research.progress" && (
                    <p className="mt-0.5 truncate text-[11px] text-[var(--muted)]">
                      {event.data.message}
                    </p>
                  )}
                  {event.type === "task.failed" && (
                    <p className="mt-0.5 text-[11px] text-[var(--danger)]">
                      {event.data.message}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}

      {error && (
        <p
          role="alert"
          className="rounded-md border border-[#71343d] bg-[#32181d] px-3 py-2 text-sm text-[#ff969c]"
        >
          {error}
        </p>
      )}
    </section>
  );
}
