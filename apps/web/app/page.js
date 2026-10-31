"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

export default function HomePage() {
  const [session, setSession] = useState(undefined);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/get-session", { credentials: "include" })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        if (!cancelled) setSession(payload?.user ?? null);
      })
      .catch(() => {
        if (!cancelled) setSession(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-6 px-6">
      <p className="text-sm font-semibold uppercase tracking-widest text-slate-500">
        EvidenceGraph
      </p>
      <h1 className="text-4xl font-semibold tracking-tight text-slate-900">
        Research grounded in evidence.
      </h1>
      <p className="max-w-2xl text-lg leading-8 text-slate-600">
        Submit a question, watch background workers gather and verify evidence,
        approve the research plan, and read a cited report grounded in your
        documents and the web.
      </p>
      <div className="flex gap-3">
        {session === undefined ? (
          <span className="text-sm text-slate-500">Checking session…</span>
        ) : session ? (
          <Link
            href="/workspace"
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
          >
            Open workspace
          </Link>
        ) : (
          <Link
            href="/sign-in"
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
          >
            Sign in
          </Link>
        )}
      </div>
    </main>
  );
}
