"use client";

const statusTone = {
  queued: "text-[var(--muted)]",
  processing: "text-[var(--signal-bright)]",
  awaiting_approval: "text-[var(--warning)]",
  completed: "text-[var(--success)]",
  failed: "text-[var(--danger)]",
  cancelled: "text-[var(--quiet)]",
};

function statusMark(status) {
  if (status === "processing") return "◉";
  if (status === "completed") return "✓";
  if (status === "failed") return "!";
  if (status === "awaiting_approval") return "◇";
  if (status === "cancelled") return "—";
  return "○";
}

export default function TaskList({ tasks, selectedId, onSelect }) {
  if (tasks.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-[var(--line)] bg-[var(--canvas-raised)] px-4 py-5">
        <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--quiet)]">
          No runs recorded
        </p>
        <p className="mt-2 text-sm leading-5 text-[var(--muted)]">
          Submit a question to open an evidence trail.
        </p>
      </div>
    );
  }

  return (
    <ul className="flex flex-col gap-1.5">
      {tasks.map((task, index) => {
        const selected = task.id === selectedId;
        return (
          <li key={task.id}>
            <button
              type="button"
              onClick={() => onSelect?.(task.id)}
              aria-current={selected ? "true" : undefined}
              className={`group flex min-h-14 w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                selected
                  ? "border-[#823b45] bg-[#2a191d] shadow-[inset_2px_0_0_#e55b66]"
                  : "border-transparent bg-transparent hover:border-[var(--line-soft)] hover:bg-[var(--canvas-raised)]"
              }`}
            >
              <span
                className={`mt-0.5 w-5 shrink-0 text-center font-mono text-xs ${statusTone[task.status] ?? "text-[var(--muted)]"}`}
              >
                {statusMark(task.status)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block line-clamp-2 text-[13px] leading-[1.4] text-[var(--ink-soft)] group-hover:text-[var(--ink)]">
                  {task.question}
                </span>
                <span className="mt-1.5 flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.1em] text-[var(--quiet)]">
                  <span>{String(tasks.length - index).padStart(2, "0")}</span>
                  <span aria-hidden="true">·</span>
                  <span
                    className={statusTone[task.status] ?? "text-[var(--muted)]"}
                  >
                    {task.status.replaceAll("_", " ")}
                  </span>
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
