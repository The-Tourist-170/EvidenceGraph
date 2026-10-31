# EvidenceGraph — Final Evaluation

This report summarizes what was built, how it was verified, and where the
project's honest limits are. Every verification number below comes from an
actual local run; no live LLM or web-search provider results are claimed.

Date: 2026-10-31 · Runtime: Bun 1.4.3 on macOS (OrbStack Docker)

## 1. What was built

A full-stack agentic deep-research platform, developed phase by phase with a
tutorial per phase under `docs/tutorials/`.

| Phase | Commit    | Delivered                                                                                                          |
| ----- | --------- | ------------------------------------------------------------------------------------------------------------------ |
| 0     | `4616b25` | Bun monorepo, Zod config, ESLint/Prettier, Compose infrastructure, Next.js shell                                   |
| 1     | `5afc19d` | Bun-native API (`Bun.serve`), task/document routes, validation, replayable SSE                                     |
| 2     | `db02f7c` | BullMQ/Valkey queues, retries, idempotency, cancellation markers, MinIO objects                                    |
| 3     | `0f9a994` | Independent research/document workers, timeouts, cooperative cancel, stalled-job recovery                          |
| 4     | `b1a1c14` | PostgreSQL/Drizzle metadata, PDF/text extraction, chunks, Qdrant + Neo4j, legacy import                            |
| 5     | `c025aff` | Provider-neutral MCP (stdio + Streamable HTTP), LLM/embedding/rerank adapters, guardrails, observability           |
| 6     | `aca053a` | LangGraph research graph, hybrid RRF retrieval, verification, approval interrupts, PostgreSQL checkpoints, reports |
| 7     | `9e2a28b` | Better Auth, workspace-scoped identity, Next.js workspace, live progress, approval UI, cited report view           |

### Runtime architecture

- **API** — `Bun.serve()` with Fetch handlers; auth, validation, SSE, readiness.
- **Workers** — two independent processes: research (LangGraph graph) and
  document ingestion (extract → chunk → embed → index).
- **PostgreSQL** — tasks, events, documents, chunks, reports/revisions,
  Better Auth users/sessions, LangGraph checkpoints.
- **Valkey** — BullMQ queues, cancellation markers, SSE streams, idempotency.
- **MinIO** — document object bytes under opaque keys.
- **Qdrant** — dense + BM25 sparse vectors with tenant payload filters.
- **Neo4j** — documents, entities, claims, typed relationships.
- **Next.js** — same-origin proxy to the API; sign-in, workspace, reports.

### Research workflow (Phase 6)

`plan → retrieve (hybrid dense+sparse RRF → rerank → graph expand) → evaluate
(coverage loop with iteration cap) → verify (citation filtering) → approval
(checkpointed interrupt, resumable) → report (persisted revision with sources)`.

## 2. Verification matrix

| Check                                                             | Command                           | Result                                                    |
| ----------------------------------------------------------------- | --------------------------------- | --------------------------------------------------------- |
| Unit + contract tests                                             | `bun test`                        | **135 pass, 8 skip, 0 fail** (352 expectations, 26 files) |
| Lint                                                              | `bun run lint`                    | clean                                                     |
| Formatting                                                        | `bun run format:check`            | clean                                                     |
| Frozen install                                                    | `bun install --frozen-lockfile`   | no changes (624 packages)                                 |
| Web production build                                              | `bun --cwd apps/web build`        | 5 routes, succeeds                                        |
| Compose validation                                                | `docker compose config -q`        | valid                                                     |
| Queue integration (Valkey/MinIO)                                  | `bun run test:phase2:integration` | 1 pass, 0 fail                                            |
| Worker integration (cancel/timeout/recovery)                      | `bun run test:phase3:integration` | 2 pass, 0 fail (stable across 3 consecutive runs)         |
| Storage integration (Postgres/Qdrant/Neo4j/MinIO + legacy import) | `bun run test:phase4:integration` | 1 pass, 0 fail                                            |
| Checkpoint integration (LangGraph in PostgreSQL)                  | `bun run test:phase6:integration` | 2 pass, 0 fail (includes Phase 4 suite)                   |
| Auth integration (Better Auth vs PostgreSQL)                      | `bun run test:phase7:integration` | 3 pass, 0 fail                                            |
| HTTP end-to-end smoke (through Next proxy)                        | `bun run test:phase7:e2e`         | **11/11 checks passed**                                   |
| Release verification (empty-schema migration + volume safety)     | `bun scripts/verify-release.js`   | **8/8 checks passed**                                     |

The end-to-end smoke verifies page rendering, proxied sign-up and session
reading, authenticated workspace-scoped task creation, `401` for missing
sessions, workspace listing, and approval rejected while a task is not paused.

Release verification creates an empty database, runs migrations into it,
re-runs them for idempotency, and proves existing data is untouched: task row
counts and schema unchanged, Valkey key count and a probe key unchanged, and a
MinIO probe object still readable. The temporary database is dropped afterward.

## 3. Security and failure-mode review

**Secrets and configuration**

- All provider settings come from environment/Zod config; nothing is
  hardcoded. `.env` is gitignored; `.env.example` contains placeholders only.
- Production fails closed: missing `AUTH_SECRET`/`AUTH_URL`, `DATABASE_URL`,
  Valkey/MinIO credentials, or graph/Vector URLs abort startup or the request.
- Provider errors are classified to stable codes; raw provider bodies, headers,
  and secret values are never logged or returned.

**Authentication and authorization**

- Identity comes only from the Better Auth session cookie; caller headers can
  never set identity.
- `x-workspace-id` is a scope selector validated against `workspace_members`;
  a foreign workspace yields `403 WORKSPACE_FORBIDDEN`.
- Every repository query filters on `userId` + `workspaceId`; Qdrant searches
  carry mandatory tenant filters; Neo4j operations require `workspaceId`.
- API in-memory rate limits (per identity) plus Better Auth rate limiting and
  an MCP search request rate limiter.

**Untrusted content (prompt-injection defenses)**

- Retrieved text is normalized, length-bounded, stripped of control characters,
  and wrapped in explicit `<untrusted-data>` blocks with system prompts that
  declare it data, never instructions.
- URLs must be HTTP(S) without embedded credentials.
- Tool arguments reject reserved prototype keys, cap JSON size and depth.
- Model-proposed citations are filtered to source IDs that actually exist in
  the retrieved set; invented citations are dropped and a report with zero
  valid citations fails with `RESEARCH_CITATIONS_MISSING`.

**Operational safety**

- Request body limit 1 MiB JSON, 5 MiB upload; strict Zod validation on every
  boundary.
- Cooperative cancellation returns `202` until the worker acknowledges; terminal
  `cancelled` only after acknowledgement.
- Workers use non-retryable errors for configuration failures so BullMQ does
  not burn retries.
- Migrations never race: production requires an explicit `bun run db:migrate`;
  workers only verify schema existence.

## 4. Honest limitations

1. **No live provider results.** No MCP server or LLM/embedding/rerank
   endpoint was supplied for this environment. Tests use a local MCP fixture
   server (real stdio and real Streamable HTTP transports) and mocked model
   clients. Without configuration, production research fails with
   `WEB_SEARCH_UNAVAILABLE` rather than fabricating results; development can
   run the deterministic synthetic path only when `AI_INTEGRATIONS_ENABLED` is
   not set.
2. **No browser-automation suite.** End-to-end coverage is HTTP-level
   (`phase7-e2e-smoke.js`) plus component/API unit tests. Playwright-style
   browser journeys are future work.
3. **No formal benchmark harness.** The roadmap's benchmarking activity was
   not implemented as a committed benchmark suite; metrics collection (tokens,
   latency, retries, approximate cost) exists in the integration layer, and
   observed integration timings are recorded above as anecdote, not benchmark.
4. **Workspace model is minimal.** Each user gets an implicit personal
   workspace (first membership). Workspace creation, invitations, and role
   management UI are not built; the schema and membership validation are in
   place for them.
5. **Report export and graph-explorer UI are not built.** Reports are persisted
   with revisions and rendered with citations; Markdown/PDF export and an
   interactive Neo4j explorer are future work over existing data.
6. **Extraction scope.** Document ingestion supports PDF, plain text, and
   Markdown. Office formats and web-content extraction are not implemented.
7. **Single-instance assumptions.** The API rate limiter is in-memory; multi-
   replica deployments need a shared limiter.
8. **LangSmith tracing** is implemented but disabled by default and untested
   against a live LangSmith project here.
9. **Knowledge extraction writes entities/claims/relationships** through tested
   repository code, but the full pipeline from a live model into Neo4j was not
   exercised without provider credentials.

## 5. How to run it

See `README.md` for setup, ports, tests, and provider configuration. Short
version:

```sh
cp .env.example .env && bun install
docker compose up -d && bun run db:migrate
NODE_ENV=development bun run dev:api
bun run dev:workers:research   # terminal 2
bun run dev:workers:documents  # terminal 2
API_ORIGIN=http://localhost:3000 bun --cwd apps/web dev
```

Open `http://localhost:3001`, create an account, and submit a question.

## 6. Verdict

The project meets its completion condition as a reproducible, deployable
application: all eight phases are implemented and committed separately, every
automated check above passes locally, migrations are proven safe from an empty
schema, execution is observable and recoverable (timeouts, stalled-job
recovery, cancellation, checkpointed resume), and research output is
source-grounded by construction (citation filtering with an explicit failure
when evidence is insufficient). The remaining gaps are provider credentials,
browser-level end-to-end automation, and several UI conveniences — all
documented rather than papered over.
