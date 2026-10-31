import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { getDatabaseConfig } from "@evidencegraph/config";
import {
  createPostgresDatabase,
  users,
  workspaceMembers,
  workspaces,
} from "@evidencegraph/persistence";
import { createAuthInstance } from "./index.js";

const integrationEnabled = process.env.RUN_PHASE7_INTEGRATION === "1";
const integrationTest = integrationEnabled ? test : test.skip;
const suffix = randomUUID().slice(0, 8);
const createdUserIds = [];
const createdWorkspaceIds = [];
let database;
let auth;

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

async function authRequest(path, { method = "GET", body, cookie } = {}) {
  return auth.instance.handler(
    new Request(`http://localhost:3000${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  );
}

describe("Phase 7 Better Auth integration", () => {
  beforeAll(async () => {
    if (!integrationEnabled) return;
    const env = {
      ...process.env,
      NODE_ENV: "test",
      DATABASE_URL:
        process.env.DATABASE_URL ??
        "postgres://evidencegraph:local-dev-password@localhost:5433/evidencegraph",
    };
    database = createPostgresDatabase({ config: getDatabaseConfig(env) });
    await database.migrate();
    auth = createAuthInstance({ env, db: database.db });
  }, 120_000);

  afterAll(async () => {
    if (!integrationEnabled) return;
    if (database && createdUserIds.length > 0) {
      await database.db
        .delete(workspaceMembers)
        .where(inArray(workspaceMembers.userId, createdUserIds));
      if (createdWorkspaceIds.length > 0) {
        await database.db
          .delete(workspaces)
          .where(inArray(workspaces.id, createdWorkspaceIds));
      }
      await database.db.delete(users).where(inArray(users.id, createdUserIds));
    }
    if (auth) await auth.close();
    if (database) await database.close();
  }, 60_000);

  integrationTest(
    "signs up a user, reads the session, and resolves workspace membership",
    async () => {
      const email = `phase7-${suffix}@evidencegraph.test`;
      const signUp = await authRequest("/api/auth/sign-up/email", {
        method: "POST",
        body: { email, password: "Sup3rSecret!", name: "Phase Seven" },
      });
      expect(signUp.status).toBe(200);
      const created = await signUp.json();
      createdUserIds.push(created.user.id);
      const cookie = cookieHeader(signUp);
      expect(cookie).toContain("session_token");

      const session = await authRequest("/api/auth/get-session", { cookie });
      expect(session.status).toBe(200);
      const sessionPayload = await session.json();
      expect(sessionPayload.user.email).toBe(email);

      const identity = await auth.authenticate(
        new Request("http://localhost:3000/api/v1/research-tasks", {
          headers: { cookie },
        }),
      );
      expect(identity).toEqual({
        userId: created.user.id,
        workspaceId: created.user.id,
      });
    },
    60_000,
  );

  integrationTest(
    "rejects a workspace the session is not a member of",
    async () => {
      const email = `phase7b-${suffix}@evidencegraph.test`;
      const signUp = await authRequest("/api/auth/sign-up/email", {
        method: "POST",
        body: { email, password: "Sup3rSecret!", name: "Phase Seven B" },
      });
      expect(signUp.status).toBe(200);
      const created = await signUp.json();
      createdUserIds.push(created.user.id);
      const cookie = cookieHeader(signUp);

      await expect(
        auth.authenticate(
          new Request("http://localhost:3000/api/v1/workspaces", {
            headers: { cookie, "x-workspace-id": "not-my-workspace" },
          }),
        ),
      ).rejects.toMatchObject({
        status: 403,
        code: "WORKSPACE_FORBIDDEN",
      });
    },
    60_000,
  );

  integrationTest(
    "rejects credentials for the wrong password",
    async () => {
      const response = await authRequest("/api/auth/sign-in/email", {
        method: "POST",
        body: {
          email: `phase7c-${suffix}@evidencegraph.test`,
          password: "wrong-password",
        },
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
    },
    60_000,
  );
});
