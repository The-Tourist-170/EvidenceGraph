# Phase 4 Tutorial: Persistence & Knowledge

## 1. Phase Overview

Phase 4 makes EvidenceGraph's state durable. Before this phase, task and document metadata lived in Valkey hashes, uploaded bytes lived in MinIO, and no vector or graph storage existed. That was enough to prove asynchronous delivery and background execution, but not enough to survive restarts, support multiple users and workspaces safely, or prepare for real retrieval.

This phase adds three storage systems and connects them to the existing API and workers:

- **PostgreSQL + Drizzle ORM** for users, sessions, workspaces, research tasks, task events, documents, document chunks, sources, reports, report revisions, and idempotency keys.
- **Qdrant** for dense and BM25 sparse chunk vectors, with tenant-scoped payload indexes.
- **Neo4j** for document nodes, entity nodes, and `MENTIONS` relationships, with uniqueness constraints.

It also adds real document processing: PDF and plain-text extraction, normalization, deterministic chunking with stable chunk IDs, and chunk persistence. MinIO keeps the object bytes; PostgreSQL keeps their metadata and chunks.

Two boundaries are intentional:

1. **No real embeddings in production.** Phase 4 defines the vector schema and repository contracts. Test fixtures supply vectors so the storage path is verified. Phase 5 connects an embedding provider.
2. **No LLM or web search yet.** Research workers still produce a deterministic synthetic result. Phase 5 replaces that executor.

The result is a platform where a task, its event history, a document, its chunks, its graph node, and its vectors all have durable, tenant-scoped homes before the AI orchestration layer is built.

## 2. Learning Objectives

After this phase, you should be able to:

- Model multi-tenant application state with Drizzle ORM and PostgreSQL.
- Generate, run, and verify SQL migrations safely in development and production.
- Implement idempotent repository writes and ownership-scoped queries.
- Move the API and workers from transient Valkey metadata to a durable aggregate repository.
- Extract text from PDFs and plain text, normalize it, and chunk it with stable identifiers.
- Design a Qdrant collection with dense and sparse vectors plus payload indexes.
- Filter vector searches by workspace and user so tenants cannot read each other's data.
- Model a small knowledge graph in Neo4j with idempotent `MERGE` writes and constraints.
- Delete a document consistently across PostgreSQL, MinIO, Qdrant, and Neo4j.
- Import legacy Valkey task metadata into PostgreSQL without destroying the old keys.
- Expose readiness for every dependency without leaking credentials.
- Explain why Phase 4 stores index infrastructure but defers embedding generation.

## 3. Prerequisites

You need Bun 1.4.3 or compatible later, Docker with Compose (OrbStack is what this project uses), and the repository dependencies installed.

```sh
cp .env.example .env
bun install
```

Start all infrastructure:

```sh
docker compose up -d
docker compose ps
```

This phase expects five healthy services:

| Service    | Host URL                                                                   | Purpose                                          |
| ---------- | -------------------------------------------------------------------------- | ------------------------------------------------ |
| Valkey     | `redis://localhost:6380`                                                   | BullMQ queues, SSE streams, cancellation markers |
| MinIO      | `http://localhost:9000`                                                    | Uploaded object bytes                            |
| PostgreSQL | `postgres://evidencegraph:local-dev-password@localhost:5433/evidencegraph` | Durable metadata                                 |
| Qdrant     | `http://localhost:6335`                                                    | Dense and sparse vectors                         |
| Neo4j      | `bolt://localhost:7688`                                                    | Document and entity graph                        |

Host ports are deliberately remapped because another local project already owns Valkey `6379`, PostgreSQL `5432`, Qdrant `6333/6334`, and Neo4j `7474/7687`. Do not stop those containers to free the defaults; use the remapped ports.

Relevant `.env` values:

```dotenv
DATABASE_URL=postgres://evidencegraph:local-dev-password@localhost:5433/evidencegraph
QDRANT_URL=http://localhost:6335
EMBEDDING_DIMENSIONS=1536
NEO4J_URI=bolt://localhost:7688
NEO4J_AUTH=neo4j/local-dev-password
```

`getDatabaseConfig()`, `getQdrantConfig()`, and `getNeo4jConfig()` validate these values through Zod. In production, missing values fail closed instead of silently falling back to local defaults.

Run migrations before starting the API or workers:

```sh
bun run db:migrate
```

The API also migrates automatically in local development. Production requires an explicit migration step so multiple API replicas never race schema changes.

## 4. Architecture Explanation

The API owns the durable metadata and dispatches work. Workers own the longer-running stages. Each store has one clear responsibility.

```mermaid
flowchart LR
  Client["Client"] --> API["Bun API"]
  API --> PG["PostgreSQL<br/>tasks, documents, events"]
  API --> VK["Valkey<br/>queues, streams, cancellation"]
  API --> S3["MinIO<br/>object bytes"]
  API --> QD["Qdrant<br/>chunk vectors"]
  API --> N4J["Neo4j<br/>document graph"]
  VK --> DW["Document worker"]
  DW --> S3
  DW --> PG
  DW --> N4J
  DW --> QD2["Qdrant<br/>Phase 5 embeddings"]
  PG --> RW["Research worker"]
  linkStyle 0 stroke:#2563eb,stroke-width:2px;
  linkStyle 1,2,3,4,5 stroke:#0f766e,stroke-width:2px;
  linkStyle 6 stroke:#7c3aed,stroke-width:2px;
  linkStyle 7,8,9,10 stroke:#0891b2,stroke-width:2px;
  linkStyle 11 stroke:#16a34a,stroke-width:2px;
```

### Why split state this way?

- **PostgreSQL is the source of truth for metadata.** It gives transactions, constraints, indexes, and relational ownership. Valkey hashes are fast but are not a durable system of record.
- **Valkey remains the coordination layer.** BullMQ relies on it for queues, locks, and retries. SSE replay uses Valkey Streams. Cancellation uses a marker key. These are short-lived, high-throughput concerns.
- **MinIO stores bytes, not metadata.** Object keys are opaque and server-generated. PostgreSQL points to them.
- **Qdrant stores vectors plus a small filterable payload.** The payload duplicates just enough metadata to scope searches and render results without a second round trip.
- **Neo4j stores relationships.** It answers "which entities does this document mention?" without scanning relational tables.

### Document ingestion stage flow

```mermaid
flowchart LR
  Upload["POST /documents"] --> S3["Store bytes in MinIO"]
  Upload --> PG["Insert document row"]
  Upload --> Q["Enqueue ingestion job"]
  Q --> Read["Read object"]
  Read --> Verify["Verify byte size"]
  Verify --> Extract["Extract text"]
  Extract --> Normalize["Normalize text"]
  Normalize --> Chunk["Chunk with stable IDs"]
  Chunk --> Chunks["Save chunks in PostgreSQL"]
  Chunks --> Graph["Upsert Neo4j document"]
  Graph --> Ready["Ingestion ready"]
  linkStyle 0,1,2 stroke:#2563eb,stroke-width:2px;
  linkStyle 3,4,5,6 stroke:#0f766e,stroke-width:2px;
  linkStyle 7,8 stroke:#7c3aed,stroke-width:2px;
  linkStyle 9,10 stroke:#16a34a,stroke-width:2px;
```

The ingestion worker does not generate embeddings. It stops after durable chunks and graph metadata exist. This keeps the phase boundary honest: vector storage is ready, vector production is not.

## 5. Step-by-Step Implementation

### 5.1 Define the PostgreSQL schema

`packages/persistence/src/schema.js` defines the tables with Drizzle's PostgreSQL core types.

Authentication-compatible tables:

- `user`, `session`, `account`, `verification` mirror the Better Auth model used in a later phase.
- `workspaces` and `workspace_members` model tenant membership.

Application tables:

- `research_tasks` stores the question, validated config, status, timestamps, owner, fingerprint, execution ID, retry linkage, result JSON, and idempotency key name.
- `task_events` stores replayable events with a unique `(task_id, event_id)` constraint.
- `documents` stores filename, media type, size, status, MinIO object key, and owner.
- `document_chunks` stores ordered text chunks with a unique `(document_id, chunk_index)` constraint.
- `sources`, `reports`, and `report_revisions` reserve the report shape used later.
- `idempotency_keys` reserves request keys with an expiry.

Two design choices matter:

1. **Owner columns are explicit.** `userId` and `workspaceId` appear on every tenant-owned table, with indexes such as `research_tasks_owner_created_idx`. Queries filter on both. This is defense in depth alongside application checks.
2. **`onDelete` behavior is intentional.** Chunks cascade when a document is deleted. Task events cascade when a task is deleted. Report revisions cascade when a report is deleted. References that must survive, such as a source pointing at a removed document, use `set null`.

The task row also keeps `initializing` and `flushing` flags. They are a compatibility bridge for the SSE progress buffer.

### 5.2 Generate and run migrations

`packages/persistence/drizzle.config.js` points Drizzle Kit at the schema and the `drizzle/` output directory.

Generate a migration after changing the schema:

```sh
bun run db:generate
```

That produces SQL plus metadata under `packages/persistence/drizzle/`. Generated Drizzle metadata is excluded from Prettier because Prettier cannot parse it as source.

Apply migrations:

```sh
bun run db:migrate
```

The runner in `packages/persistence/src/migrate.js` calls `database.migrate()` and, outside production, seeds the local owner:

```js
await database.migrate();
if (process.env.NODE_ENV !== "production") {
  await repository.ensureOwner({
    userId: "local-user",
    workspaceId: "local-workspace",
  });
}
```

`createPostgresDatabase()` wraps a `postgres` client with conservative pool settings (`max: 10`, `connect_timeout: 5`, `prepare: false`). `prepare: false` matters when running through poolers that do not support prepared statements.

It exposes four useful operations:

- `checkHealth()` runs `select 1`.
- `migrate()` runs the Drizzle migrator.
- `verifySchema()` checks that `public.research_tasks` exists.
- `close()` drains the pool with a timeout.

Workers call `verifySchema()` during initialization. They do not run migrations, so a worker start can never race the API's schema change.

### 5.3 Implement repositories

`packages/persistence/src/repository.js` implements the PostgreSQL repository.

Ownership is ensured lazily. `ensureOwner(owner)` inserts the user, workspace, and owner membership with `onConflictDoNothing()`. Local development uses `local-user`/`local-workspace`; other identities receive a deterministic placeholder email so tests do not need a full auth flow.

Writes are upserts:

```js
await db
  .insert(researchTasks)
  .values(values)
  .onConflictDoUpdate({ target: researchTasks.id, set: updates });
```

That makes repeated saves idempotent. A worker retry or an API status refresh can write the same record without duplicating rows.

Reads are owner-scoped:

```js
await db
  .select()
  .from(researchTasks)
  .where(
    and(
      eq(researchTasks.userId, owner.userId),
      eq(researchTasks.workspaceId, owner.workspaceId),
    ),
  )
  .orderBy(desc(researchTasks.createdAt))
  .limit(limit);
```

Chunk replacement is transactional:

```js
await db.transaction(async (transaction) => {
  await transaction
    .delete(documentChunks)
    .where(eq(documentChunks.documentId, documentId));
  await transaction.insert(documentChunks).values(rows);
});
```

Deleting first and inserting inside one transaction means a re-ingestion either fully replaces the chunk set or leaves the previous set intact. No reader sees a half-written document.

Idempotency reservations are also durable. `reserveIdempotency()` removes expired keys, inserts a new key, and returns either a new resource ID or the existing resource ID plus its stored record. A reused key with a different request fingerprint becomes a conflict rather than a silent duplicate.

### 5.4 Wire the API and workers to the aggregate repository

`packages/persistence/src/index.js` composes one aggregate:

```js
export function createPostgresPersistence({
  config = getDatabaseConfig(),
  env = process.env,
  graphConfig = getNeo4jConfig(env),
  vectorConfig = getQdrantConfig(env),
} = {}) {
  const database = createPostgresDatabase({ config });
  const metadata = createPostgresTaskRepository({ database, env });
  const graphRepository = createNeo4jRepository({ config: graphConfig });
  const vectorRepository = createQdrantRepository({ config: vectorConfig });
  // ...
}
```

It exposes three things the queue store and workers need:

- `checkComponents()` returns `postgres`, `qdrant`, and `neo4j` readiness independently.
- `deleteDocumentIndexes()` deletes Qdrant points and the Neo4j document together.
- `close()` closes all three clients and rethrows the first failure after attempting every close.

The API passes the aggregate into `createBullMqStore({ runtime, objectStorage, repository: persistence })`. The queue store becomes a thin coordinator: BullMQ still owns jobs, but every task and document read or write goes through the repository.

Startup order matters:

1. In development, run migrations.
2. Initialize the store, object storage, and persistence.
3. Start `Bun.serve()`.

Shutdown closes the store, which closes the repository clients.

Readiness now aggregates every dependency:

```js
const dependencies = {
  valkey: checks[0].status === "fulfilled" ? "ready" : "unavailable",
  minio: checks[1].status === "fulfilled" ? "ready" : "unavailable",
};
if (repository?.checkComponents) {
  Object.assign(dependencies, await repository.checkComponents());
}
```

A single unavailable dependency makes `/ready` return `503`. The response names the dependency but never includes URLs or credentials.

### 5.5 Extract, normalize, and chunk documents

`apps/workers/src/extractors/document.js` handles two input families:

- `application/pdf` through `pdfjs-dist`.
- `text/plain`, `text/markdown`, and `text/x-markdown` through `TextDecoder("utf-8", { fatal: true })`.

PDF extraction uses the legacy build with `disableFontFace`, `isEvalSupported: false`, and `useWorkerFetch: false`. Standard font data is resolved to a filesystem path rather than a `file://` URL, because PDF.js does not accept the URL form in this environment:

```js
const pdfjsEntry = import.meta.resolve("pdfjs-dist/legacy/build/pdf.mjs");
const standardFontDataUrl = `${fileURLToPath(
  new URL("../../standard_fonts/", pdfjsEntry),
)}/`;
```

Every page is cleaned up, and the loading task is destroyed in `finally`. Skipping either leaks memory across jobs.

Normalization uses NFKC, normalizes line endings, strips NUL bytes, collapses trailing spaces, and limits blank lines. It is deterministic, so the same input produces the same output.

Chunking:

- Default chunk size is 1,200 characters with 120 characters of overlap.
- Boundaries prefer the last space after 60% of the chunk, avoiding mid-word cuts when possible.
- Each chunk ID is a stable UUID derived from `documentId:index:content`.
- Metadata records `startOffset` and `endOffset`.

Stable IDs matter. Re-ingesting the same document produces the same chunk identities, which lets Phase 5 upsert vectors instead of duplicating them.

Unsupported media types, empty text, decoding failures, and PDF parse failures become BullMQ `UnrecoverableError`s. A corrupt file should not burn retry attempts.

The executor `apps/workers/src/executors/document-ingestion.js` then:

1. Reports progress and reads the MinIO object.
2. Verifies the byte size against the job payload.
3. Computes a SHA-256 digest.
4. Extracts and chunks text.
5. Saves chunks transactionally.
6. Upserts the Neo4j document node.

### 5.6 Configure Qdrant

`packages/retrieval/src/index.js` creates one collection named `evidencegraph_chunks`.

```js
await qdrant.createCollection(collectionName, {
  vectors: {
    dense: { size: config.dimensions, distance: "Cosine" },
  },
  sparse_vectors: { bm25: {} },
});
```

Why both vector types? Hybrid retrieval usually combines:

- Dense vectors for semantic similarity.
- Sparse BM25-style vectors for exact-term matching.

Creating both now means Phase 5 can write both without a migration.

Payload indexes are created for `workspaceId`, `userId`, and `documentId`. Searches always include a tenant filter:

```js
filter: {
  must: [
    { key: "workspaceId", match: { value: workspaceId } },
    { key: "userId", match: { value: userId } },
  ],
}
```

Logical isolation is not enough on its own, but filtering in the query is the last line of defense if an application-level check is ever missed.

Validation happens before the network call. `upsertPoints()` rejects:

- A dense vector whose length differs from `EMBEDDING_DIMENSIONS`.
- Sparse vectors whose `indices` and `values` lengths differ.
- Payloads that do not match the strict schemas.

`searchDense()` and `searchSparse()` validate the query vector and bound `limit` to 1–100. `deleteDocument()` requires all three tenant identifiers, so a deletion cannot accidentally match another tenant's points.

The client version is pinned exactly to `@qdrant/js-client-rest@1.13.0` to match server `v1.13.4`. Version 1.20 removed the `.search()` method this repository uses, so upgrading without rewriting the client calls would break retrieval at runtime.

### 5.7 Configure Neo4j

`packages/persistence/src/graph.js` creates two uniqueness constraints:

```cypher
CREATE CONSTRAINT evidence_document_id IF NOT EXISTS
FOR (d:EvidenceDocument) REQUIRE d.id IS UNIQUE

CREATE CONSTRAINT evidence_entity_workspace_name IF NOT EXISTS
FOR (e:EvidenceEntity) REQUIRE (e.workspaceId, e.normalizedName) IS UNIQUE
```

The entity constraint is composite. The same concept name can exist in two workspaces, but not twice in one workspace.

Writes use `MERGE`, so retries are idempotent:

```cypher
MATCH (d:EvidenceDocument {id: $documentId, workspaceId: $workspaceId})
UNWIND $entities AS entity
MERGE (e:EvidenceEntity {
  workspaceId: $workspaceId,
  normalizedName: entity.normalizedName
})
SET e.name = entity.name, e.kind = entity.kind, e.id = entity.id
MERGE (d)-[:MENTIONS]->(e)
```

`upsertEntities()` runs inside `session.executeWrite()`, giving one transaction for the document and all entity links.

Deletion is owner-scoped and cleans orphans:

```cypher
MATCH (d:EvidenceDocument {
  id: $documentId, workspaceId: $workspaceId, userId: $userId
})
DETACH DELETE d
```

A second statement removes entities in that workspace that no longer have any relationship. Without it, deleted documents would leave dangling concept nodes behind.

Traversal is bounded. `getDocumentEntities()` requires a workspace and caps results at 500.

### 5.8 Keep data consistent

Deletion spans four systems. `store.deleteDocument()` handles the ordering:

1. Reject if the ingestion job is active.
2. Remove the BullMQ job.
3. Delete Qdrant points and the Neo4j document through `deleteDocumentIndexes()`.
4. Delete the MinIO object.
5. Delete the PostgreSQL document row, which cascades chunks.

If a secondary store fails, the operation surfaces the error rather than pretending the document is gone everywhere. Retrying is safe because each store's delete is idempotent.

Legacy import keeps the migration reversible. `importLegacyRedis()` scans `evidencegraph:task:<uuid>` hashes, recreates each task row, imports events from `evidencegraph:events:<id>` streams, and imports idempotency reservations. Inserts use `onConflictDoNothing()`. The legacy Valkey keys are left untouched, so rollback is still possible.

One subtlety surfaced during integration: the SSE progress buffer used to check `initializing` and `flushing` flags inside the Valkey task hash. Once tasks moved to PostgreSQL, those flags were no longer atomically visible to a Lua script. The fix was to move the buffer gates to dedicated Valkey keys:

- `evidencegraph:task-initializing:<id>`
- `evidencegraph:task-flushing:<id>`

The durable task row still records the same flags, but Redis now controls the Redis buffer. `setTaskFlags()` updates the PostgreSQL row with a partial `UPDATE`, avoiding a full-record write that could overwrite a concurrently observed execution ID.

That execution ID needed one more guarantee. A worker returns a new ID on each attempt, including a recovered stalled job. If the API marks the task complete from the queue event before the final progress frame arrives, the row could keep the interrupted attempt's ID. Workers now include `executionId` in the successful result envelope, and `transitionTask()` reconciles it when the result is stored. Tracing stays correct even when event ordering is not.

## 6. Code Walkthrough

### `packages/persistence/src/schema.js`

Defines every table, index, unique constraint, and foreign key. Read this file first; it is the canonical description of what durable state exists.

### `packages/persistence/src/database.js`

Wraps `postgres()` and Drizzle. The important behaviors are bounded pool settings, `prepare: false`, a migration runner pointed at `../drizzle`, schema verification, and graceful close.

### `packages/persistence/src/repository.js`

The largest file in the phase. It implements:

- `ensureOwner()`
- task CRUD and listing
- document CRUD and listing
- chunk replacement
- idempotency reservation
- event append and read
- legacy import
- `initialize()` and `close()`

Notice that every public read that lists resources takes an owner. There is no unscoped list operation.

### `packages/persistence/src/index.js`

The aggregate factory. It hides the fact that persistence spans three clients and gives the API one object with `checkComponents`, `deleteDocumentIndexes`, and `close`.

### `packages/persistence/src/graph.js`

Neo4j access with schema validation at the boundary, parameterized Cypher, explicit sessions, and `executeWrite` transactions.

### `packages/retrieval/src/index.js`

Qdrant collection setup, payload indexes, validated upserts, dense and sparse search, and tenant-scoped deletion.

### `apps/workers/src/extractors/document.js`

PDF and text extraction, normalization, and deterministic chunking.

### `apps/workers/src/executors/document-ingestion.js`

The worker stage orchestration. It verifies the object, extracts text, saves chunks, and writes the graph node.

### `packages/queue/src/store.js`

Still owns queue coordination, but now delegates metadata to the repository. The Phase 4 additions are visible in:

- `setTaskFlags` delegation when a repository provides it.
- Valkey marker keys for the progress buffer.
- Execution ID reconciliation from the completed result.

## 7. Testing and Verification

### Unit and contract tests

```sh
bun test
```

Expected result at the end of this phase: 62 passing tests, with the real-service integration suites skipped by default.

These tests cover:

- API envelopes, validation, cancellation semantics, and SSE behavior.
- Worker execution context, cancellation, and timeout behavior.
- Config parsing, including production fail-closed rules.
- Qdrant repository validation with fake clients.
- Neo4j repository validation with fake drivers.
- Document extraction, including a generated PDF.
- Chunk stability and overlap behavior.

### Real Phase 4 integration

```sh
docker compose up -d
bun run db:migrate
bun run test:phase4:integration
```

This suite runs against real PostgreSQL, Qdrant, Neo4j, MinIO, and Valkey. It verifies:

- Task creation is durable and idempotent.
- A reused idempotency key with a different fingerprint returns `409`.
- Cancellation is recorded.
- Document upload, metadata read, and content read work.
- Chunks round-trip through PostgreSQL.
- A Neo4j document and entity can be written and traversed.
- Qdrant accepts dense and sparse vectors and returns them for a tenant-scoped search.
- Legacy Valkey metadata imports into PostgreSQL.
- Document deletion removes the object, chunks, graph node, and vectors.

### Revalidate the earlier phases

Phase 4 changes shared code, so the earlier real-service suites must still pass:

```sh
bun run test:phase2:integration
bun run test:phase3:integration
```

Phase 2 verifies queue dispatch, deduplication, retries, cancellation, SSE streaming, and MinIO objects. Phase 3 verifies both workers against the PostgreSQL-backed runtime, including graceful shutdown, timeout classification, and stalled-job recovery.

### Quality checks

```sh
bun run lint
bun run format:check
bun --cwd apps/web build
```

### Manual readiness check

Start the API:

```sh
bun run dev:api
```

Then:

```sh
curl -s http://localhost:3000/ready
```

A healthy response reports `valkey`, `minio`, `postgres`, `qdrant`, and `neo4j` as `ready`. Stop one service and the endpoint returns `503` with that dependency marked `unavailable`.

## 8. Common Issues

### `DATABASE_URL` missing in production

The config layer fails closed. This is intentional. Set `DATABASE_URL` in the production environment and run `bun run db:migrate` before starting the API.

### Migrations hang or fail because the database is unavailable

Check `docker compose ps` and the remapped port. The local URL uses `5433`, not `5432`.

### Qdrant search throws `qdrant.search is not a function`

The installed client is newer than the pinned version. Keep `@qdrant/js-client-rest` at `1.13.0` for server `v1.13.4`, or rewrite the calls for the newer API. Do not disable compatibility checks to hide the mismatch.

### Vector dimension mismatch

`EMBEDDING_DIMENSIONS` must match the length of every dense vector. Phase 4 does not generate embeddings, so a mismatch usually means a test fixture or a copied vector is wrong.

### PDF extraction fails with a font error

PDF.js needs a filesystem path for `standardFontDataUrl`, not a `file://` URL. Confirm the resolved path points at `pdfjs-dist/standard_fonts/`.

### Neo4j authentication failure

`NEO4J_AUTH` uses the `username/password` form. The config layer rejects values without a separator. The local default is `neo4j/local-dev-password`.

### Documents exist in MinIO but not in PostgreSQL

A partial failure occurred between object upload and metadata insert. Phase 4 keeps the write order API-first, so the metadata row is the anchor. If you find orphaned objects in development, they are safe to delete; a reconciliation job is a later operational concern.

### Old task appears after restart

That is the point of this phase. If a task is missing, check that the API is using the PostgreSQL repository, not the transitional Valkey-only store. The integration suite asserts durable reads for exactly this reason.

### `Task was already completed` style ordering surprises

Queue events and progress frames can arrive in different orders. The store treats terminal statuses as sticky and reconciles the execution ID from the completed result. Do not add a second place that writes task status directly to the database.

## 9. Interview Preparation

### Why move metadata from Valkey to PostgreSQL?

Valkey is excellent for fast coordination but is not a durable relational system of record. PostgreSQL provides transactions, constraints, indexes, and multi-tenant querying. Keeping Valkey for queues and streams preserves the performance characteristics that made Phase 2 and 3 work.

### How do you prevent one workspace from reading another's data?

Three layers:

1. Every repository read that lists or fetches tenant data takes an owner and filters on both `userId` and `workspaceId`.
2. Qdrant searches always include a tenant filter.
3. Neo4j writes and reads include `workspaceId`, and deletion includes `userId`.

Application checks alone are not enough; the storage queries must also enforce scope.

### Why use `onConflictDoUpdate` for task writes?

Workers and the API can both write the same task as progress and status events arrive. An upsert makes those writes idempotent. A worker retry then cannot create a duplicate task row or fail because the row already exists.

### Why is chunk replacement transactional?

If the delete commits but the insert fails, the document would lose its searchable content. Doing both in one transaction means readers see either the old chunk set or the new one.

### Why store both dense and sparse vectors?

Dense vectors capture semantic similarity; sparse BM25-style vectors capture exact terms. Hybrid retrieval combines them. Creating both collections now avoids a schema migration when Phase 5 starts writing real embeddings.

### Why not generate embeddings in Phase 4?

Embedding generation requires an external model provider, batching, cost control, and version tracking. Those belong with the Phase 5 LLM integration. Phase 4 proves that the storage and query contracts work using fixtures.

### Why does the worker not run migrations?

If every worker ran migrations at startup, replicas would race the same DDL. A single explicit migration step (or the API in local development) owns schema changes. Workers only verify that the schema exists.

### How does document deletion stay consistent across four stores?

The API deletes indexes and the object first, then removes the relational row, which cascades chunks. Each delete is idempotent. If a step fails, the operation fails visibly and can be retried safely. This is a deliberate trade-off: availability of the delete operation is lower, but the system never claims a deletion succeeded when part of the data remains.

### Why is the execution ID in the result envelope?

A recovered stalled job runs with a new execution ID. If completion is observed before the final progress frame, the row could keep the old ID. Including the ID in the result gives the store a reliable place to reconcile tracing data.

### What would you change before production?

- Add reconciliation jobs for orphaned objects and orphaned index entries.
- Add retention policies for events, sessions, and idempotency keys.
- Add database connection metrics and query latency monitoring.
- Add backup and restore drills for PostgreSQL, Qdrant, and Neo4j.
- Replace the development migration-on-start with a deployment migration gate.
- Add encryption at rest and audit logging for tenant data access.

### How would you explain this phase in an interview?

"Phase 4 turned a working async prototype into a durable platform. We introduced PostgreSQL with Drizzle for relational metadata, kept Valkey for queue coordination, associated MinIO objects with durable records, added real PDF and text extraction with deterministic chunking, and established Qdrant and Neo4j schemas with tenant-scoped access. We deliberately deferred embedding generation to Phase 5, so the phase boundary stays honest and every storage contract is tested with real services."

## 10. Phase Summary

Phase 4 delivers:

- A Drizzle schema and SQL migration for the full application state.
- PostgreSQL repositories with idempotent writes and owner-scoped reads.
- An aggregate persistence runtime spanning PostgreSQL, Qdrant, and Neo4j.
- API and worker integration with the durable store.
- PDF and text extraction, normalization, and stable chunking.
- Qdrant collections for dense and sparse vectors with payload indexes.
- Neo4j constraints, document/entity writes, traversal, and cleanup.
- Cross-store document deletion and legacy Valkey import.
- Readiness reporting for all five dependencies.
- 62 passing unit tests and a real-service integration suite covering all storage systems.

Deferred to Phase 5:

- Real LLM calls and provider adapters.
- External MCP or skill-based web search.
- Embedding generation and vector indexing of real documents.
- Graph entity extraction from model output.
- LangGraph orchestration and retrieval over the stored knowledge.
