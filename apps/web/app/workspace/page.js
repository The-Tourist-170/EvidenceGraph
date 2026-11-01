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
const activeDocumentStatuses = new Set(["queued", "processing"]);

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
      // Keep the last known view if a transient refresh fails.
    }
  }, []);

  const refreshDocuments = useCallback(async () => {
    try {
      setDocuments(await api.listDocuments());
    } catch {
      // Upload and row-level errors are surfaced by DocumentPanel.
    }
  }, []);

  const acceptUploadedDocument = useCallback((document) => {
    setDocuments((current) => [
      document,
      ...current.filter((item) => item.id !== document.id),
    ]);
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
    const taskTimer = setInterval(() => void refreshTasks(), 3_000);
    return () => clearInterval(taskTimer);
  }, [ready, refreshTasks, refreshDocuments]);

  const hasActive = tasks.some((task) => activeStatuses.has(task.status));
  const hasActiveDocuments = documents.some((document) =>
    activeDocumentStatuses.has(document.status),
  );

  useEffect(() => {
    if (!ready || !hasActiveDocuments) return undefined;
    const timer = setInterval(() => void refreshDocuments(), 1_200);
    return () => clearInterval(timer);
  }, [ready, hasActiveDocuments, refreshDocuments]);

  const selectedTask = tasks.find((task) => task.id === selectedId) ?? null;

  async function signOut() {
    await authApi.signOut();
    router.replace("/");
  }

  if (!ready) {
    return (
      <main className="workspace-shell grid min-h-screen place-items-center">
        <div className="flex items-center gap-3 text-sm text-[var(--ink-soft)]">
          <span className="loader-ring" aria-hidden="true" />
          Verifying your session
        </div>
      </main>
    );
  }

  return (
    <main className="workspace-shell">
      <WorkspaceHeader user={user} onSignOut={signOut} />
      <div className="workspace-layout">
        <aside
          className="workspace-rail"
          aria-label="Research workspace sidebar"
        >
          <section
            className="flex flex-col gap-3"
            aria-labelledby="history-title"
          >
            <div className="flex items-center justify-between">
              <div>
                <p className="eyebrow">
                  Queue / {String(tasks.length).padStart(2, "0")}
                </p>
                <h2
                  id="history-title"
                  className="mt-1 text-base font-semibold text-[var(--ink)]"
                >
                  Research runs
                </h2>
              </div>
              {hasActive && (
                <span className="flex items-center gap-2 text-[11px] text-[var(--signal-bright)]">
                  <span className="status-dot" />
                  Live
                </span>
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

          <div className="h-px bg-[var(--line-soft)]" />
          <DocumentPanel
            documents={documents}
            onChanged={refreshDocuments}
            onUploaded={acceptUploadedDocument}
          />
          <p className="mt-auto border-t border-[var(--line-soft)] pt-4 font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--quiet)]">
            Private workspace · source-grounded runs
          </p>
        </aside>

        <section className="workspace-canvas" aria-label="Research operations">
          {reportTaskId ? (
            <ReportView
              taskId={reportTaskId}
              onClose={() => setReportTaskId(null)}
            />
          ) : (
            <>
              <div className="flex flex-wrap items-end justify-between gap-4">
                <div>
                  <p className="eyebrow">EvidenceGraph / Research operations</p>
                  <h1 className="mt-2 max-w-3xl text-2xl font-semibold leading-tight tracking-tight text-[var(--ink)] sm:text-3xl">
                    Ask a question. Follow the evidence.
                  </h1>
                </div>
                <span className="flex items-center gap-2 pb-1 text-xs text-[var(--muted)]">
                  <span className="status-dot" />
                  Workers online
                </span>
              </div>

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
                <section className="panel flex min-h-64 flex-col justify-between overflow-hidden p-6">
                  <div>
                    <p className="eyebrow">Run console</p>
                    <h2 className="mt-2 text-lg font-semibold text-[var(--ink)]">
                      Your evidence trail will appear here
                    </h2>
                    <p className="mt-2 max-w-xl text-sm leading-6 text-[var(--muted)]">
                      Planning, search, local retrieval, verification, and
                      citations stay attached to each run. Select a prior run to
                      inspect its activity or start a new question above.
                    </p>
                  </div>
                  <div className="mt-8 grid grid-cols-3 gap-3 border-t border-[var(--line-soft)] pt-4">
                    {[
                      ["01", "Plan"],
                      ["02", "Gather"],
                      ["03", "Verify"],
                    ].map(([number, label]) => (
                      <div key={number} className="flex items-center gap-2">
                        <span className="font-mono text-xs text-[var(--signal-bright)]">
                          {number}
                        </span>
                        <span className="text-xs text-[var(--ink-soft)]">
                          {label}
                        </span>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </>
          )}
        </section>
      </div>
    </main>
  );
}
