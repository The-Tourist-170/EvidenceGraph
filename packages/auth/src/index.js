import { getAuthConfig, getDatabaseConfig } from "@evidencegraph/config";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import * as schema from "@evidencegraph/persistence/schema";

export function createAuthInstance({
  env = process.env,
  authConfig = getAuthConfig(env),
  databaseConfig = getDatabaseConfig(env),
  db,
} = {}) {
  const ownsClient = !db;
  const client = db
    ? undefined
    : postgres(databaseConfig.url, {
        max: 10,
        connect_timeout: 5,
        idle_timeout: 20,
        prepare: false,
      });
  const database = db ?? drizzle(client, { schema });

  const instance = betterAuth({
    appName: "EvidenceGraph",
    secret: authConfig.secret,
    baseURL: authConfig.url,
    trustedOrigins: authConfig.trustedOrigins,
    database: drizzleAdapter(database, {
      provider: "pg",
      schema: {
        user: schema.users,
        session: schema.sessions,
        account: schema.accounts,
        verification: schema.verifications,
      },
    }),
    emailAndPassword: {
      enabled: authConfig.enableSignUp,
      autoSignIn: true,
      requireEmailVerification: false,
    },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 30,
    },
    advanced: {
      ipAddress: {
        ipAddressHeaders: ["x-forwarded-for", "x-real-ip"],
      },
    },
  });

  async function authenticate(request) {
    const session = await instance.api.getSession({ headers: request.headers });
    if (!session?.user) return null;
    const userId = session.user.id;
    const memberships = await database
      .select({ workspaceId: schema.workspaceMembers.workspaceId })
      .from(schema.workspaceMembers)
      .where(eq(schema.workspaceMembers.userId, userId))
      .orderBy(schema.workspaceMembers.createdAt);
    const requested = request.headers.get("x-workspace-id");
    if (requested) {
      if (!memberships.some((row) => row.workspaceId === requested)) {
        const error = new Error(
          "The requested workspace is not available for this session.",
        );
        error.status = 403;
        error.code = "WORKSPACE_FORBIDDEN";
        throw error;
      }
      return { userId, workspaceId: requested };
    }
    return {
      userId,
      workspaceId: memberships[0]?.workspaceId ?? userId,
    };
  }

  async function listWorkspaces(userId) {
    const rows = await database
      .select({
        id: schema.workspaceMembers.workspaceId,
        role: schema.workspaceMembers.role,
        createdAt: schema.workspaceMembers.createdAt,
      })
      .from(schema.workspaceMembers)
      .where(eq(schema.workspaceMembers.userId, userId))
      .orderBy(schema.workspaceMembers.createdAt);
    return rows.map((row) => ({
      id: row.id,
      role: row.role,
      createdAt: new Date(row.createdAt).toISOString(),
    }));
  }

  async function close() {
    if (ownsClient && client) await client.end({ timeout: 5 });
  }

  return {
    api: instance.api,
    authenticate,
    close,
    database,
    instance,
    listWorkspaces,
  };
}

export async function handleAuthRequest({ request, auth }) {
  return auth.instance.handler(request);
}
