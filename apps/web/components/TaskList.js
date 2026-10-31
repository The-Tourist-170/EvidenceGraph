"use client";

const statusStyles = {
  queued: "bg-slate-100 text-slate-700",
  processing: "bg-blue-100 text-blue-700",
  awaiting_approval: "bg-amber-100 text-amber-800",
  completed: "bg-emerald-100 text-emerald-800",
  failed: "bg-red-100 text-red-700",
  cancelled: "bg-slate-200 text-slate-600",
};

export default function TaskList({ tasks, selectedId, onSelect }) {
  if (tasks.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-slate-300 p-4 text-sm text-slate-500">
        No research tasks yet. Submit a question to start one.
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-2">
      {tasks.map((task) => (
        <li key={task.id}>
          <button
            type="button"
            onClick={() => onSelect?.(task.id)}
            aria-current={task.id === selectedId ? "true" : undefined}
            className={`flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2 text-left transition-colors hover:border-slate-400 ${
              task.id === selectedId
                ? "border-slate-900 bg-slate-50"
                : "border-slate-200 bg-white"
            }`}
          >
            <span className="truncate text-sm text-slate-800">
              {task.question}
            </span>
            <span
              className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                statusStyles[task.status] ?? "bg-slate-100 text-slate-700"
              }`}
            >
              {task.status.replace("_", " ")}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
