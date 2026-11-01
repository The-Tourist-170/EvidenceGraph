"use client";

import { useState } from "react";
import { ApiClientError, api } from "../lib/api.js";

const defaultConfig = {
  depth: "standard",
  maxSources: 10,
  maxIterations: 3,
  maxDurationSeconds: 300,
  requiresApproval: false,
};

export default function ResearchForm({ onCreated }) {
  const [question, setQuestion] = useState("");
  const [config, setConfig] = useState(defaultConfig);
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(false);

  function update(key, value) {
    setConfig((current) => ({ ...current, [key]: value }));
  }

  async function submit(event) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const task = await api.createTask({ question: question.trim(), config });
      setQuestion("");
      onCreated?.(task);
    } catch (caught) {
      setError(
        caught instanceof ApiClientError ? caught.message : String(caught),
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="panel relative flex flex-col gap-4 overflow-hidden p-4 sm:p-5"
    >
      <div className="pointer-events-none absolute -right-16 -top-20 h-48 w-48 rounded-full bg-[radial-gradient(circle,rgb(164_48_61_/_17%),transparent_68%)]" />
      <div className="relative flex items-start justify-between gap-4">
        <div>
          <p className="eyebrow">New investigation</p>
          <h2 className="mt-1 text-base font-semibold text-[var(--ink)]">
            Define the research question
          </h2>
        </div>
        <span className="rounded-md border border-[var(--line-soft)] bg-black/20 px-2 py-1 font-mono text-[9px] uppercase tracking-[0.1em] text-[var(--quiet)]">
          R / 01
        </span>
      </div>

      <label className="relative flex flex-col gap-2 text-xs font-semibold text-[var(--ink-soft)]">
        Research question
        <textarea
          required
          minLength={10}
          maxLength={2000}
          rows={3}
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder="How do urban trees reduce summer heat?"
          className="field min-h-24 resize-y text-sm leading-6"
        />
        <span className="self-end font-mono text-[10px] font-normal text-[var(--quiet)]">
          {question.length} / 2,000
        </span>
      </label>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <label className="flex flex-col gap-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-[var(--muted)]">
          Depth
          <select
            value={config.depth}
            onChange={(event) => update("depth", event.target.value)}
            className="field py-2 text-xs normal-case tracking-normal"
          >
            <option value="quick">Quick</option>
            <option value="standard">Standard</option>
            <option value="deep">Deep</option>
          </select>
        </label>
        <label className="flex flex-col gap-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-[var(--muted)]">
          Max sources
          <input
            type="number"
            min={1}
            max={50}
            value={config.maxSources}
            onChange={(event) =>
              update("maxSources", Number(event.target.value))
            }
            className="field py-2 text-xs tabular-nums"
          />
        </label>
        <label className="flex flex-col gap-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-[var(--muted)]">
          Iterations
          <input
            type="number"
            min={1}
            max={10}
            value={config.maxIterations}
            onChange={(event) =>
              update("maxIterations", Number(event.target.value))
            }
            className="field py-2 text-xs tabular-nums"
          />
        </label>
        <label className="flex flex-col gap-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-[var(--muted)]">
          Timeout / sec
          <input
            type="number"
            min={10}
            max={300}
            value={config.maxDurationSeconds}
            onChange={(event) =>
              update("maxDurationSeconds", Number(event.target.value))
            }
            className="field py-2 text-xs tabular-nums"
          />
        </label>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--line-soft)] pt-3">
        <label className="flex min-h-10 items-center gap-2.5 text-xs text-[var(--ink-soft)]">
          <input
            type="checkbox"
            checked={config.requiresApproval}
            onChange={(event) =>
              update("requiresApproval", event.target.checked)
            }
            className="h-4 w-4 accent-[#d44a55]"
          />
          Pause for plan approval
        </label>
        <button
          type="submit"
          disabled={pending || question.trim().length < 10}
          className="button-primary inline-flex items-center justify-center gap-2 disabled:cursor-not-allowed disabled:opacity-45"
        >
          {pending ? (
            <>
              <span className="loader-ring h-4 w-4" aria-hidden="true" />
              Starting run
            </>
          ) : (
            "Start investigation"
          )}
        </button>
      </div>

      {error && (
        <p
          role="alert"
          className="rounded-md border border-[#69353d] bg-[#35191e] px-3 py-2 text-sm text-[#ff9ca1]"
        >
          {error}
        </p>
      )}
    </form>
  );
}
