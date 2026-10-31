"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import DocumentPanel from "../../components/DocumentPanel.js";
import ReportView from "../../components/ReportView.js";
import ResearchForm from "../../components/ResearchForm.js";
import TaskDetail from "../../components/TaskDetail.js";
import TaskList from "../../components/TaskList.js";
import WorkspaceHeader from "../../components/WorkspaceHeader.js";
import { api, authApi } from "../../lib/api.js";

const activeStatuses = new Set(["queued", "processing"]);

export default function WorkspacePage() {
  const router = useRouter();
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);
  const [tasks, setTasks] = useState([]);
  const [documents, setDocuments] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [reportTaskId, setReportTaskId] = useState(null);

  const refreshTasks = useCallback(async () => {
    try {
      setTasks(await api.listTasks());
    } catch {
      // Session problems are handled by the redirect below.
    }
  }, []);

  const refreshDocuments = useCallback(async () => {
    try {
      setDocuments(await api.listDocuments());
    } catch {
      // Document list failures are surfaced when uploading.
    }
  }, []);

  const handleTaskChanged = useCallback((next) => {
    setTasks((current) =>
      current.some((task) => task.id === next.id)
        ? current.map((task) => (task.id === next.id ? next : task))
        : [next, ...current],
    );
    if (next.retryOf) setSelectedId(next.id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    authApi
      .session()
      .then((session) => {
        if (cancelled) return;
        if (!session) {
          router.replace("/sign-in");
          return;
        }
        setUser(session.user);
        setReady(true);
      })
      .catch(() => {
        if (!cancelled) router.replace("/sign-in");
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  useEffect(() => {
    if (!ready) return undefined;
    void refreshTasks();
    void refreshDocuments();
    const timer = setInterval(() => {
      void refreshTasks();
    }, 3_000);
    return () => clearInterval(timer);
  }, [ready, refreshTasks, refreshDocuments]);

  const selectedTask = tasks.find((task) => task.id === selectedId) ?? null;
  const hasActive = tasks.some((task) => activeStatuses.has(task.status));

  async function signOut() {
    await authApi.signOut();
    router.replace("/");
  }

  if (!ready) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md items-center justify-center px-6">
        <p className="text-sm text-slate-500">Loading workspace…</p>
      </main>
    );
  }

  if (reportTaskId) {
    return (
      <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-4 px-6 py-8">
        <WorkspaceHeader user={user} onSignOut={signOut} />
        <ReportView
          taskId={reportTaskId}
          onClose={() => setReportTaskId(null)}
        />
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 px-6 py-8">
      <WorkspaceHeader user={user} onSignOut={signOut} />

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div className="flex flex-col gap-6">
          <ResearchForm
            onCreated={(task) => {
              setTasks((current) => [task, ...current]);
              setSelectedId(task.id);
              void refreshTasks();
            }}
          />
          {selectedTask ? (
            <TaskDetail
              task={selectedTask}
              onChanged={handleTaskChanged}
              onOpenReport={(id) => setReportTaskId(id)}
            />
          ) : (
            <p className="text-sm text-slate-500">
              Select a task to watch its live progress.
            </p>
          )}
        </div>

        <div className="flex flex-col gap-6">
          <section className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
                Research history
              </h2>
              {hasActive && (
                <span className="text-xs text-slate-400">updating…</span>
              )}
            </div>
            <TaskList
              tasks={tasks}
              selectedId={selectedId}
              onSelect={(id) => {
                setReportTaskId(null);
                setSelectedId(id);
              }}
            />
          </section>
          <DocumentPanel documents={documents} onChanged={refreshDocuments} />
        </div>
      </div>
    </main>
  );
}
