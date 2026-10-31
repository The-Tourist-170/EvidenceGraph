"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { authApi } from "../../lib/api.js";

export default function SignInPage() {
  const router = useRouter();
  const [mode, setMode] = useState("sign-in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      if (mode === "sign-in") {
        await authApi.signIn({ email, password });
      } else {
        await authApi.signUp({ email, password, name });
      }
      router.push("/workspace");
    } catch (caught) {
      setError(caught.message);
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-5 px-6">
      <Link
        href="/"
        className="text-sm font-semibold uppercase tracking-widest text-slate-500"
      >
        EvidenceGraph
      </Link>
      <h1 className="text-2xl font-semibold text-slate-900">
        {mode === "sign-in" ? "Sign in" : "Create your account"}
      </h1>
      <form onSubmit={submit} className="flex flex-col gap-4">
        {mode === "sign-up" && (
          <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
            Name
            <input
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoComplete="name"
              className="rounded-md border border-slate-300 px-3 py-2 text-slate-900 focus:border-slate-500 focus:outline-none"
            />
          </label>
        )}
        <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
          Email
          <input
            required
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="email"
            className="rounded-md border border-slate-300 px-3 py-2 text-slate-900 focus:border-slate-500 focus:outline-none"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
          Password
          <input
            required
            type="password"
            minLength={8}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete={
              mode === "sign-in" ? "current-password" : "new-password"
            }
            className="rounded-md border border-slate-300 px-3 py-2 text-slate-900 focus:border-slate-500 focus:outline-none"
          />
        </label>
        {error && (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-60"
        >
          {pending ? "Working…" : mode === "sign-in" ? "Sign in" : "Sign up"}
        </button>
      </form>
      <button
        type="button"
        onClick={() => setMode(mode === "sign-in" ? "sign-up" : "sign-in")}
        className="text-left text-sm text-slate-600 underline hover:text-slate-900"
      >
        {mode === "sign-in"
          ? "Need an account? Sign up"
          : "Already have an account? Sign in"}
      </button>
    </main>
  );
}
