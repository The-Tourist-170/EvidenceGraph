import { fileURLToPath } from "node:url";
import { migrate as runMigrations } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { getDatabaseConfig } from "@evidencegraph/config";
import * as schema from "./schema.js";

export function createPostgresDatabase({ config = getDatabaseConfig() } = {}) {
  const client = postgres(config.url, {
    max: 10,
    connect_timeout: 5,
    idle_timeout: 20,
    prepare: false,
  });
  const db = drizzle(client, { schema });

  return {
    db,
    async checkHealth() {
      await client`select 1`;
      return true;
    },
    async migrate() {
      await runMigrations(db, {
        migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
      });
    },
    async verifySchema() {
      const [row] = await client`
        select to_regclass('public.research_tasks') as table_name
      `;
      if (!row?.table_name) {
        throw new Error(
          "PostgreSQL schema is missing; run `bun run db:migrate`.",
        );
      }
    },
    async close() {
      await client.end({ timeout: 5 });
    },
  };
}
