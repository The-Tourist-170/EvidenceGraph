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
    <header className="workspace-topbar">
      <div className="flex min-w-0 items-center gap-4">
        <Link
          href="/workspace"
          className="flex shrink-0 items-center gap-3 text-[var(--ink)]"
        >
          <span className="grid h-9 w-9 place-items-center rounded-[10px] border border-[#74343e] bg-[linear-gradient(145deg,#53242c,#201316)] font-mono text-sm font-bold text-[#ff7980] shadow-[0_0_26px_rgb(181_45_58_/_17%)]">
            EG
          </span>
          <span className="hidden sm:block">
            <span className="block text-[13px] font-semibold tracking-wide">
              EvidenceGraph
            </span>
            <span className="mt-0.5 block font-mono text-[9px] uppercase tracking-[0.16em] text-[var(--quiet)]">
              Research console
            </span>
          </span>
        </Link>
        <span className="hidden h-7 w-px bg-[var(--line-soft)] sm:block" />
        {workspaces.length > 0 && (
          <label className="flex min-w-0 items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--quiet)]">
            <span className="hidden sm:inline">Workspace</span>
            <select
              value={workspaces[0]?.id}
              onChange={(event) => setActiveWorkspaceId(event.target.value)}
              className="min-h-11 max-w-40 truncate rounded-md border border-[var(--line)] bg-[var(--surface)] px-2.5 py-1.5 text-xs normal-case tracking-normal text-[var(--ink-soft)]"
            >
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.id.slice(0, 12)} / {workspace.role}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <span className="hidden max-w-52 truncate text-xs text-[var(--muted)] sm:block">
          {user?.email}
        </span>
        <button
          type="button"
          onClick={onSignOut}
          className="button-secondary px-3"
        >
          Sign out
        </button>
      </div>
    </header>
  );
}
