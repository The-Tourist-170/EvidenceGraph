#!/usr/bin/env bun
/**
 * Phase 7 end-to-end smoke over HTTP.
 *
 * Start both servers first:
 *   NODE_ENV=development bun run dev:api          (repo root, port 3000)
 *   API_ORIGIN=http://localhost:3000 bun run dev  (apps/web, port 3001)
 *
 * Then run:
 *   bun apps/web/scripts/phase7-e2e-smoke.js
 *
 * It verifies page rendering, proxied sign-up/session, workspace-scoped task
 * creation, rejection of unauthenticated access, and the approval guard.
 */
const base = "http://localhost:3001";
const failures = [];

function check(label, condition, detail = "") {
  if (condition) {
    console.log(`ok - ${label}`);
  } else {
    failures.push(label);
    console.log(`FAIL - ${label} ${detail}`);
  }
}

function cookieHeader(response) {
  const cookies =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie")].filter(Boolean);
  return cookies
    .map((cookie) => cookie.split(";")[0])
    .filter(Boolean)
    .join("; ");
}

const home = await fetch(`${base}/`);
const homeHtml = await home.text();
check(
  "landing page renders",
  home.status === 200 && homeHtml.includes("EvidenceGraph"),
);

const workspacePage = await fetch(`${base}/workspace`);
check(
  "workspace route serves the shell",
  workspacePage.status === 200 && (await workspacePage.text()).length > 0,
);

const signInPage = await fetch(`${base}/sign-in`);
check(
  "sign-in route serves the form",
  signInPage.status === 200 && (await signInPage.text()).includes("Sign in"),
);

const email = `smoke-${Date.now()}@evidencegraph.test`;
const signUp = await fetch(`${base}/api/auth/sign-up/email`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email, password: "Sup3rSecret!", name: "Smoke" }),
});
const cookie = cookieHeader(signUp);
check("proxied sign-up succeeds", signUp.status === 200, String(signUp.status));
check("session cookie issued", cookie.includes("session_token"));

const session = await fetch(`${base}/api/auth/get-session`, {
  headers: { cookie },
});
const sessionPayload = await session.json();
check(
  "proxied session resolves the user",
  session.status === 200 && sessionPayload.user?.email === email,
);

const created = await fetch(`${base}/api/v1/research-tasks`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie },
  body: JSON.stringify({
    question: "How do urban trees reduce summer heat?",
    config: { depth: "standard", requiresApproval: true },
  }),
});
const createdPayload = await created.json();
check(
  "authenticated task creation returns 202",
  created.status === 202,
  String(created.status),
);

const listed = await fetch(`${base}/api/v1/research-tasks`, {
  headers: { cookie },
});
const listedPayload = await listed.json();
check(
  "task list is scoped to the session",
  listed.status === 200 &&
    Array.isArray(listedPayload.data) &&
    listedPayload.data.some((task) => task.id === createdPayload?.data?.id),
);

const unauthenticated = await fetch(`${base}/api/v1/research-tasks`);
check(
  "protected routes reject missing sessions",
  unauthenticated.status === 401,
  String(unauthenticated.status),
);

const workspaces = await fetch(`${base}/api/v1/workspaces`, {
  headers: { cookie },
});
const workspacePayload = await workspaces.json();
check(
  "workspace listing returns the personal workspace",
  workspaces.status === 200 && workspacePayload.data.length >= 1,
  JSON.stringify(workspacePayload).slice(0, 200),
);

if (createdPayload?.data?.id) {
  const approved = await fetch(
    `${base}/api/v1/research-tasks/${createdPayload.data.id}/approve`,
    {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ approved: true }),
    },
  );
  check(
    "approval is rejected while the task is not paused",
    approved.status === 409,
    String(approved.status),
  );
}

if (failures.length > 0) {
  console.error(`\n${failures.length} smoke check(s) failed.`);
  process.exit(1);
}
console.log("\nPhase 7 smoke: all checks passed.");
