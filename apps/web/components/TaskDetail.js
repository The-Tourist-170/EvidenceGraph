"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiClientError, api } from "../lib/api.js";
import { streamEvents } from "../lib/events.js";

const terminalStatuses = new Set(["completed", "failed", "cancelled"]);

function stageLabel(stage) {
  if (!stage) return "Working…";
  return stage
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
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
    <section aria-live="polite" className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">
            {task.question}
          </h2>
          <p className="text-xs uppercase tracking-wide text-slate-500">
            {task.status}
            {task.executionId ? ` · ${task.executionId.slice(0, 8)}` : ""}
          </p>
        </div>
        <div className="flex gap-2">
          {!stopped && task.status !== "awaiting_approval" && (
            <button
              type="button"
              disabled={pendingAction === "cancel"}
              onClick={() => act("cancel", () => api.cancelTask(task.id))}
              className="rounded-md border border-red-300 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50 disabled:opacity-60"
            >
              Cancel
            </button>
          )}
          {task.status === "failed" && (
            <button
              type="button"
              disabled={pendingAction === "retry"}
              onClick={() => act("retry", () => api.retryTask(task.id))}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100 disabled:opacity-60"
            >
              Retry
            </button>
          )}
          {task.status === "completed" && (
            <button
              type="button"
              onClick={() => onOpenReport?.(task.id)}
              className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700"
            >
              View report
            </button>
          )}
        </div>
      </header>

      {progress && (
        <div className="rounded-md border border-slate-200 bg-white p-3">
          <div className="flex items-center justify-between text-sm text-slate-700">
            <span>{stageLabel(progress.stage)}</span>
            <span>{progress.percent}%</span>
          </div>
          <div
            className="mt-2 h-2 w-full overflow-hidden rounded-full bg-slate-200"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress.percent}
          >
            <div
              className="h-2 rounded-full bg-teal-600 transition-[width] duration-500 motion-reduce:transition-none"
              style={{ width: `${progress.percent}%` }}
            />
          </div>
          <p className="mt-2 text-sm text-slate-500">{progress.message}</p>
        </div>
      )}

      {canApprove && (
        <form
          className="flex flex-col gap-3 rounded-md border border-amber-300 bg-amber-50 p-4"
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
          <p className="text-sm font-medium text-amber-900">
            The research plan is waiting for your approval.
          </p>
          <label className="flex flex-col gap-1 text-sm text-amber-900">
            Feedback or redirection (optional)
            <input
              value={approvalFeedback}
              onChange={(event) => setApprovalFeedback(event.target.value)}
              placeholder="Focus on surface temperature measurements."
              className="rounded-md border border-amber-400 bg-white px-3 py-2 text-slate-900"
            />
          </label>
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={pendingAction === "approve"}
              className="rounded-md bg-amber-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-800 disabled:opacity-60"
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
              className="rounded-md border border-amber-400 px-3 py-1.5 text-sm text-amber-900 hover:bg-amber-100 disabled:opacity-60"
            >
              Reject and redirect
            </button>
          </div>
        </form>
      )}

      {events.length > 0 && (
        <ol className="max-h-56 overflow-y-auto rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
          {events.map((event, index) => (
            <li key={`${event.id ?? index}`} className="py-0.5">
              <span className="font-medium text-slate-800">{event.type}</span>
              {event.type === "research.progress"
                ? ` — ${event.data.message}`
                : ""}
            </li>
          ))}
        </ol>
      )}

      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
    </section>
  );
}
