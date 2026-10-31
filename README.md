# EvidenceGraph

An agentic deep-research platform: submit a question, let background workers
gather and verify evidence from local documents, a knowledge graph, and external
MCP search, then read a source-grounded report with clickable citations.

Built with Bun, BullMQ, PostgreSQL, Qdrant, Neo4j, MinIO, LangGraph, and
Next.js — no web framework on the API side (`Bun.serve()` with Fetch handlers).

## Architecture at a glance

| Layer    | Technology            | Role                                                    |
| -------- | --------------------- | ------------------------------------------------------- |
| API      | Bun + native Fetch    | Requests, SSE, auth, readiness                          |
| Queues   | Valkey + BullMQ       | Job dispatch, retries, cancellation markers             |
| Workers  | Bun processes         | Research graph execution, document ingestion            |
| Metadata | PostgreSQL + Drizzle  | Tasks, events, documents, chunks, reports, users        |
| Vectors  | Qdrant                | Dense + BM25 sparse chunk vectors, hybrid search        |
| Graph    | Neo4j                 | Documents, entities, claims, relationships              |
| Objects  | MinIO (S3)            | Uploaded document bytes                                 |
| Auth     | Better Auth           | Sessions, users, workspace membership                   |
| AI       | LangChain / LangGraph | Planning → retrieval → verification → approval → report |
| UI       | Next.js + Tailwind    | Sign-in, workspace, live progress, reports              |

Detailed diagrams: `01_system_architecture.svg`, `02_langgraph_agent_architecture.svg`,
`03_advanced_rag_architecture.svg`.

## Prerequisites

- [Bun](https://bun.sh) 1.4.3+
- Docker with Compose (this project uses [OrbStack](https://orbstack.dev) on macOS)

## Quick start

```sh
# 1. Configure
cp .env.example .env          # local placeholders work; add provider keys for real AI

# 2. Install
bun install

# 3. Infrastructure (Valkey, MinIO, PostgreSQL, Qdrant, Neo4j)
docker compose up -d
docker compose ps             # all five should be healthy

# Worker containers are opt-in (avoid duplicate consumers with the host
# workers started below). Only start them instead of terminal 2:
#   docker compose --profile workers up -d
# Note: the slim worker image has no npx, so MCP stdio web search requires
# the host workers; containerized workers need provider values in .env.

# 4. Database schema
bun run db:migrate

# 5. API (terminal 1, port 3000)
NODE_ENV=development bun run dev:api

# 6. Workers (terminal 2)
bun run dev:workers:research
bun run dev:workers:documents

# 7. Web UI (terminal 3, port 3001)
API_ORIGIN=http://localhost:3000 bun --cwd apps/web dev
```

Open <http://localhost:3001>, create an account, and submit a research question.

### Service ports

Host ports are remapped to avoid clashing with other local projects:

| Service           | Host                      | Container       |
| ----------------- | ------------------------- | --------------- |
| Valkey            | `localhost:6380`          | `6379`          |
| MinIO API         | `localhost:9000`          | `9000`          |
| PostgreSQL        | `localhost:5433`          | `5432`          |
| Qdrant            | `localhost:6335` / `6336` | `6333` / `6334` |
| Neo4j HTTP / Bolt | `localhost:7475` / `7688` | `7474` / `7687` |
| API               | `localhost:3000`          | —               |
| Web               | `localhost:3001`          | —               |

## Provider configuration (real AI)

All LLM/search configuration lives in `.env` — never hardcode keys, model names,
or base URLs. Placeholders in `.env.example` are safe for local development;
development without providers runs the deterministic synthetic path.

```dotenv
LLM_BASE_URL=https://api.example.com/v1
LLM_MODEL_NAME=replace-with-your-model
LLM_API_KEY=replace-with-your-api-key

# Enable the real integration path outside production (production is always on)
AI_INTEGRATIONS_ENABLED=true

# Optional: embeddings, rerank endpoint, MCP search transport/URL/token
# EMBEDDING_MODEL_NAME=...   RERANK_ENDPOINT=...   MCP_SEARCH_TRANSPORT=stdio|http
```

Honest limits:

- **Web search** requires an MCP server (`MCP_SEARCH_TRANSPORT`). Without one,
  real research fails with `WEB_SEARCH_UNAVAILABLE` — production never
  substitutes mock results.
- **No fabricated output.** Automated tests use local MCP fixture servers and
  mocked model clients; live-provider results are never claimed by tests.

### Authentication

```dotenv
AUTH_SECRET=<32+ characters, required in production>
AUTH_URL=http://localhost:3000          # required in production
AUTH_TRUSTED_ORIGINS=http://localhost:3001
```

The API fails closed without these in production.

## Tests and checks

```sh
bun test                        # unit + contract tests (real services skipped)
bun run lint
bun run format:check
bun --cwd apps/web build
bun run db:generate             # generate SQL migrations after schema edits

# Real-service integration suites (require docker compose up -d)
bun run test:phase2:integration   # Valkey + MinIO queue/object behavior
bun run test:phase3:integration   # workers, cancellation, timeout, recovery
bun run test:phase4:integration   # PostgreSQL/Qdrant/Neo4j/MinIO + legacy import
bun run test:phase6:integration   # PostgreSQL LangGraph checkpoints (+ Phase 4)
bun run test:phase7:integration   # Better Auth against PostgreSQL

# HTTP end-to-end smoke (requires API :3000 and web :3001 running)
bun run test:phase7:e2e

# Release verification: migrations from an empty schema + volume safety
bun run verify:release
```

Local checks only — this project intentionally has no GitHub Actions
configuration.

## Migration safety

- Development: the API applies migrations at startup.
- Production: run `bun run db:migrate` explicitly before deploying; workers
  only verify the schema and never race migrations.
- Migrations are additive and idempotent; they create tables in an empty
  database without touching existing MinIO/Valkey/PostgreSQL volumes.

## Documentation

Each phase has a beginner-friendly tutorial with architecture, walkthrough,
verification, troubleshooting, and interview Q&A:

- `docs/tutorials/phase-0-project-initialization.md`
- `docs/tutorials/phase-1-api-and-streaming.md`
- `docs/tutorials/phase-2-asynchronous-delivery.md`
- `docs/tutorials/phase-3-background-execution.md`
- `docs/tutorials/phase-4-persistence-and-knowledge.md`
- `docs/tutorials/phase-5-external-integrations.md`
- `docs/tutorials/phase-6-ai-orchestration-and-retrieval.md`
- `docs/tutorials/phase-7-user-experience.md`
- `docs/final-evaluation.md` — architecture, verification matrix, limitations

`roadmap.md` is the phase-by-phase development plan with an implementation
status checklist.

## Troubleshooting

- **Port conflicts** — see the port table above; the `ash-agent` containers on
  this machine own the default ports, do not stop them.
- **`403 INVALID_ORIGIN` on sign-in/sign-up** — the API process was started
  before `AUTH_TRUSTED_ORIGINS` existed (restart it), or the browser origin is
  not allowed. Localhost variants are trusted automatically in development;
  add LAN origins (e.g. `http://192.168.1.13:3001`) to `AUTH_TRUSTED_ORIGINS`.
- **Research results are synthetic** — the research worker did not enable real
  integrations (a duplicate worker without `.env` is consuming the queue, or
  `AI_INTEGRATIONS_ENABLED` is unset). Stop containerized workers
  (`docker compose stop research-worker document-worker`) and restart the host
  workers; their startup logs print `Research integrations initialized`.
- **`429 RATE_LIMITED`** — the API allows 120 requests per minute per
  workspace; a stuck UI polling loop or test scripts sharing an identity can
  exhaust it. Wait a minute or raise `rateLimit` in `createApiHandler`.
- **`503 AUTH_NOT_CONFIGURED`** — production started without `AUTH_SECRET` /
  `AUTH_URL`, or the API was built without an auth instance.
- **`WEB_SEARCH_UNAVAILABLE`** — configure `MCP_SEARCH_TRANSPORT` and its
  command/URL in `.env`.
- **Docker unavailable** — if you use OrbStack, check the daemon with
  `orb status` and start it.
- **Qdrant client errors** — keep `@qdrant/js-client-rest` pinned to `1.13.0`
  to match the `v1.13.4` server.
