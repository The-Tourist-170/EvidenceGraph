#!/usr/bin/env bun
/**
 * Release verification: run migrations against an EMPTY database and prove the
 * existing PostgreSQL, Valkey, and MinIO data is untouched by the migration.
 *
 *   bun scripts/verify-release.js
 *
 * Requires docker compose to be up. Creates and drops a temporary database.
 */
import { createObjectStorage } from "../packages/object-storage/src/index.js";
import { createPostgresDatabase } from "../packages/persistence/src/database.js";
import { createQueueRuntime } from "../packages/queue/src/queues.js";
import {
  getMinioConfig,
  getValkeyConfig,
} from "../packages/config/src/index.js";

const baseUrl =
  process.env.DATABASE_URL ??
  "postgres://evidencegraph:local-dev-password@localhost:5433/evidencegraph";
const tempUrl = baseUrl.replace(/\/[^/]+$/, "/evidencegraph_release_check");

const failures = [];
function check(label, condition, detail = "") {
  if (condition) console.log(`ok - ${label}`);
  else {
    failures.push(label);
    console.log(`FAIL - ${label} ${detail}`);
  }
}

const adminDatabase = createPostgresDatabase({ config: { url: baseUrl } });
const tempDatabase = createPostgresDatabase({ config: { url: tempUrl } });
const env = { ...process.env, NODE_ENV: "test" };
const runtime = createQueueRuntime(getValkeyConfig(env));
const storage = createObjectStorage({ config: getMinioConfig(env) });

const expectedTables = [
  "research_tasks",
  "task_events",
  "documents",
  "document_chunks",
  "reports",
  "report_revisions",
  "user",
  "session",
  "workspace_members",
  "idempotency_keys",
];

async function tableExists(database, table) {
  const [row] = await database.db.execute(
    `select to_regclass('public.${table}') as table_name`,
  );
  return Boolean(row?.table_name);
}

try {
  // Snapshot existing data and write probes that would vanish if a volume
  // were reset.
  await storage.initialize();
  const probeKey = `release-check/probe-${Date.now()}.txt`;
  await storage.putObject({
    key: probeKey,
    bytes: new TextEncoder().encode("release-verification-probe"),
    mediaType: "text/plain",
  });
  await runtime.redis.set("release-check:probe", "1", "EX", 600);
  const beforeKeys = await runtime.redis.dbsize();
  const [mainRow] = await adminDatabase.db.execute(
    "select count(*)::int as count from research_tasks",
  );
  const beforeTaskCount = mainRow.count;

  // 1. Migrations against a genuinely empty schema.
  await adminDatabase.db.execute(
    "drop database if exists evidencegraph_release_check",
  );
  await adminDatabase.db.execute("create database evidencegraph_release_check");
  console.log("created empty database evidencegraph_release_check");
  await tempDatabase.migrate();

  let missing = [];
  for (const table of expectedTables) {
    if (!(await tableExists(tempDatabase, table))) missing.push(table);
  }
  check(
    "migrations create the full schema in an empty database",
    missing.length === 0,
    `missing: ${missing.join(", ")}`,
  );

  // Idempotency: migrating again must not fail or duplicate.
  await tempDatabase.migrate();
  const [twice] = await tempDatabase.db.execute(
    "select count(*)::int as count from research_tasks",
  );
  check("re-running migrations is idempotent", twice.count === 0);

  // 2. Existing data untouched.
  const [mainAfter] = await adminDatabase.db.execute(
    "select count(*)::int as count from research_tasks",
  );
  check(
    "existing PostgreSQL task rows are unchanged",
    mainAfter.count === beforeTaskCount,
    `${beforeTaskCount} -> ${mainAfter.count}`,
  );
  let mainMissing = [];
  for (const table of expectedTables) {
    if (!(await tableExists(adminDatabase, table))) mainMissing.push(table);
  }
  check(
    "existing database schema is intact",
    mainMissing.length === 0,
    `missing: ${mainMissing.join(", ")}`,
  );

  const afterKeys = await runtime.redis.dbsize();
  check(
    "Valkey keys are not modified by migration",
    afterKeys === beforeKeys,
    `${beforeKeys} -> ${afterKeys}`,
  );
  check(
    "Valkey probe key survives migration",
    (await runtime.redis.get("release-check:probe")) === "1",
  );
  await runtime.redis.del("release-check:probe");

  const probe = await storage.getObject(probeKey);
  check(
    "MinIO probe object survives migration",
    new TextDecoder().decode(probe.bytes) === "release-verification-probe",
  );
  await storage.deleteObject(probeKey);
} catch (error) {
  failures.push("verification ran without exceptions");
  console.error("FAIL - verification threw:", error);
} finally {
  await tempDatabase.close().catch(() => {});
  try {
    await adminDatabase.db.execute(
      "drop database if exists evidencegraph_release_check",
    );
    console.log("dropped temporary database");
  } catch (error) {
    console.error("could not drop temp database:", error.message);
    process.exitCode = 1;
  }
  await adminDatabase.close().catch(() => {});
  await runtime.close().catch(() => {});
  storage.close?.();
}

if (failures.length > 0) {
  console.error(`\n${failures.length} release check(s) failed.`);
  process.exit(1);
}
console.log("\nRelease verification: all checks passed.");
