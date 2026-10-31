"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, setActiveWorkspaceId } from "../lib/api.js";

export default function WorkspaceHeader({ user, onSignOut }) {
  const [workspaces, setWorkspaces] = useState([]);

  useEffect(() => {
    let cancelled = false;
    api
      .listWorkspaces()
      .then((value) => {
        if (cancelled) return;
        setWorkspaces(value);
        if (value[0]) setActiveWorkspaceId(value[0].id);
      })
      .catch(() => {
        if (!cancelled) setWorkspaces([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-4">
      <div className="flex items-center gap-3">
        <Link
          href="/"
          className="text-sm font-semibold uppercase tracking-widest text-slate-500"
        >
          EvidenceGraph
        </Link>
        {workspaces.length > 0 && (
          <label className="flex items-center gap-2 text-sm text-slate-600">
            Workspace
            <select
              defaultValue={workspaces[0]?.id}
              onChange={(event) => setActiveWorkspaceId(event.target.value)}
              className="rounded-md border border-slate-300 px-2 py-1 text-sm text-slate-900"
            >
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.id.slice(0, 12)} ({workspace.role})
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <div className="flex items-center gap-3">
        <span className="text-sm text-slate-600">{user?.email}</span>
        <button
          type="button"
          onClick={onSignOut}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100"
        >
          Sign out
        </button>
      </div>
    </header>
  );
}
