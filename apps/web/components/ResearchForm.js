"use client";

import { useState } from "react";
import { ApiClientError, api } from "../lib/api.js";

const defaultConfig = {
  depth: "standard",
  maxSources: 10,
  maxIterations: 3,
  maxDurationSeconds: 120,
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

  const fieldClass =
    "rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-slate-500 focus:outline-none";

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-4 rounded-lg border border-slate-200 bg-white p-4"
    >
      <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
        Research question
        <textarea
          required
          minLength={10}
          maxLength={2000}
          rows={3}
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder="How do urban trees reduce summer heat?"
          className={fieldClass}
        />
      </label>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
          Depth
          <select
            value={config.depth}
            onChange={(event) => update("depth", event.target.value)}
            className={fieldClass}
          >
            <option value="quick">Quick</option>
            <option value="standard">Standard</option>
            <option value="deep">Deep</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
          Max sources
          <input
            type="number"
            min={1}
            max={50}
            value={config.maxSources}
            onChange={(event) =>
              update("maxSources", Number(event.target.value))
            }
            className={fieldClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
          Max iterations
          <input
            type="number"
            min={1}
            max={10}
            value={config.maxIterations}
            onChange={(event) =>
              update("maxIterations", Number(event.target.value))
            }
            className={fieldClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
          Timeout (s)
          <input
            type="number"
            min={10}
            max={300}
            value={config.maxDurationSeconds}
            onChange={(event) =>
              update("maxDurationSeconds", Number(event.target.value))
            }
            className={fieldClass}
          />
        </label>
      </div>

      <label className="flex items-center gap-2 text-sm text-slate-700">
        <input
          type="checkbox"
          checked={config.requiresApproval}
          onChange={(event) => update("requiresApproval", event.target.checked)}
          className="h-4 w-4 accent-slate-900"
        />
        Require plan approval before writing the report
      </label>

      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="self-start rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-60"
      >
        {pending ? "Submitting…" : "Start research"}
      </button>
    </form>
  );
}
