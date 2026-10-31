# EvidenceGraph

## Development Roadmap — Version 2

**Project:** Agentic Deep Research & Knowledge Intelligence Platform

**Development strategy:** Infrastructure → API → Queues → Workers → Persistence → External Integrations → AI Intelligence → User Experience

**Core technologies:** Bun.js (`Bun.serve()`), JavaScript, Zod, Docker, Valkey, BullMQ, PostgreSQL, Qdrant, Neo4j, LangChain.js, LangGraph.js, Next.js, Tailwind CSS.

## Implementation status

- [x] Phase 0 — Project initialization
- [x] Phase 1 — API and streaming
- [x] Phase 2 — Asynchronous delivery
- [x] Phase 3 — Background execution
- [x] Phase 4 — Persistence and knowledge
- [x] Phase 5 — External service integrations
- [ ] Phase 6 — AI orchestration and advanced retrieval
- [ ] Phase 7 — User experience

Each completed phase has a tutorial under `docs/tutorials/`. Live provider
results require values in a local `.env`; automated tests use local MCP fixture
servers and mocked model clients, never fabricated production results.

---

# Phase 0 — Project Initialization

**Objective:** Establish the project structure, development tooling, service boundaries, and containerized infrastructure.

### 0.1 — Project Structure

- Initialize a Bun monorepo.
- Organize independent packages for API, workers, AI orchestration, retrieval, persistence, external integrations, and shared utilities.
- Initialize Next.js with Tailwind CSS, leaving user-facing feature development for Phase 7.
- Establish module boundaries and dependency management.

### 0.2 — Developer Tooling

- Configure JavaScript and shared JSDoc typing conventions.
- Configure ESLint and Prettier.
- Establish environment variable conventions.
- Implement configuration loading and validation using Zod.
- Configure structured logging and common error types.
- Initialize Bun's testing infrastructure and CI checks.

### 0.3 — Infrastructure

- Configure Docker and Docker Compose.
- Provision Valkey, PostgreSQL, Qdrant, Neo4j, and S3-compatible object storage.
- Configure development networks, health checks, volumes, and service-level environment variables.
- Create separate application and infrastructure Docker configurations.

### Deliverables

- Reproducible monorepo.
- Containerized local infrastructure.
- Shared configuration and validation packages.
- Basic API health check and service connectivity checks.

**Exit criteria:** All services start reliably, the workspace installs and builds successfully, and initial tests pass.

---

# Phase 1 — API & Streaming

**Architecture Layer:** 02 / API & Streaming

**Objective:** Build the backend communication interface before connecting business logic.

### 1.1 — API Foundation

- Initialize an API server using Bun's native `Bun.serve()` API.
- Establish versioned REST routes.
- Configure global middleware, error handling, and request logging.
- Implement request and response validation with Zod.
- Define consistent response envelopes and error formats.

### 1.2 — Research APIs

- Create research task submission endpoints.
- Define endpoints for retrieving research tasks, execution status, results, and history.
- Define cancellation and retry contracts.
- Define research configuration schemas, including research depth, source limits, and execution budgets.

### 1.3 — Document APIs

- Define document upload endpoints.
- Define document listing, retrieval, deletion, and ingestion-status endpoints.
- Implement input size limits and basic file validation.

### 1.4 — Streaming

- Implement Server-Sent Events (SSE).
- Define standardized events for task creation, queueing, processing, research progress, completion, failure, and cancellation.
- Implement heartbeat, connection cleanup, and reconnection support.
- Define event IDs and a strategy for replaying missed events.

### 1.5 — Security Boundaries

- Establish authentication and authorization contracts.
- Apply input guardrails, payload limits, and request throttling.
- Define user and workspace ownership rules for future persistence.

### Deliverables

- Functional REST API with simulated task execution.
- SSE transport and event schemas.
- Zod-validated API contracts.
- API integration tests.

**Exit criteria:** An API client can submit a simulated research request, retrieve its state, and subscribe to validated progress events.

---

# Phase 2 — Asynchronous Delivery

**Architecture Layer:** 03 / Async Delivery

**Objective:** Build a reliable job dispatching system for long-running research and document processing.

### 2.1 — Valkey Integration

- Configure Valkey connections.
- Establish connection management and health monitoring.
- Configure authentication, persistence, and connection retry behavior.

### 2.2 — BullMQ Infrastructure

- Configure BullMQ queues and producers.
- Create separate research and document-ingestion queues.
- Define Zod-validated job payloads and job identifiers.
- Establish queue-specific concurrency and retention settings.

### 2.3 — Job Lifecycle

- Implement enqueue, inspect, cancel, and retry operations.
- Configure bounded retries with exponential backoff.
- Implement delayed jobs and priority handling.
- Define permanent failure states and failed-job inspection.

### 2.4 — Reliability

- Implement duplicate-submission protection.
- Define idempotency keys.
- Establish queue-level observability.
- Create progress-event publishing through Valkey.
- Implement event handoff from queue events to SSE subscribers.

### 2.5 — Document Object Storage (advanced from Phase 4)

- Integrate the existing MinIO service through its S3-compatible API.
- Store document bytes under opaque, server-generated object keys.
- Enqueue document-ingestion jobs containing object references and validated metadata, not file bytes.
- Keep ownership checks, upload size/type validation, and rollback on failed queue submission.
- Keep document metadata in Valkey as a transitional Phase 2 store; Phase 4 associates MinIO objects with durable database metadata.

### Deliverables

- Operational BullMQ queues backed by Valkey.
- Reliable task dispatch and lifecycle operations.
- Job retry and cancellation mechanisms.
- Queue-level integration tests.

**Exit criteria:** Jobs can be submitted, inspected, retried, deduplicated, and cancelled using real Valkey and BullMQ infrastructure. MinIO object round-trips and the real-service integration suite must pass. Waiting jobs remain unprocessed in production until Phase 3 adds worker processes; active-job cancellation is deferred until cooperative worker cancellation exists.

---

# Phase 3 — Background Execution

**Architecture Layer:** 04 / Background Execution

**Objective:** Execute long-running workloads in independently managed Bun worker processes.

### 3.1 — Worker Services

- Create dedicated research workers.
- Create dedicated document-ingestion workers.
- Define reusable worker execution interfaces.
- Separate API and worker process lifecycles.

### 3.2 — Execution Framework

- Implement execution contexts and stage transitions.
- Support configurable worker concurrency.
- Implement task timeouts and cooperative cancellation.
- Handle worker crashes, graceful shutdown, and job recovery.

### 3.3 — Progress Communication

- Publish structured progress events.
- Connect worker updates to Valkey and SSE.
- Add execution identifiers for tracing.
- Implement structured error classification and worker logs.

### 3.4 — Reliability Testing

- Test worker interruption and restart behavior.
- Verify retries and duplicate-execution safeguards.
- Test graceful shutdown with active tasks.
- Execute simulated multi-stage research and ingestion jobs.

### Deliverables

- Independently deployable Bun worker processes.
- Complete API → BullMQ → Worker → SSE lifecycle.
- Recoverable execution and cancellation handling.
- Worker integration tests.

**Exit criteria:** Research and ingestion workloads run independently from API requests, survive recoverable failures, and publish observable execution progress.

---

# Phase 4 — Persistence & Knowledge

**Architecture Layer:** 06 / Persistence & Knowledge

**Objective:** Implement durable application state, document metadata associations to the MinIO objects established in Phase 2, vector infrastructure, and knowledge graph persistence before constructing the AI orchestration layer.

### 4.1 — PostgreSQL

- Define users, workspaces, research sessions, tasks, execution events, sources, reports, and revisions.
- Implement database migrations and repositories.
- Connect task and execution persistence to the API and worker layers.
- Implement transactional state updates and idempotent writes.
- Prepare LangGraph checkpoint storage and thread identifiers.

### 4.2 — Object Storage

- Reuse the MinIO client, bucket, and S3-compatible object keys introduced in Phase 2.
- Associate stored files with durable users, workspaces, and ingestion-task records.
- Implement persistent deduplication, retention, and deletion policies.
- Reconcile PostgreSQL metadata with MinIO objects after partial failures.

### 4.3 — Document Processing

- Build text extraction for PDFs, supported documents, and web content.
- Implement normalization and metadata extraction.
- Implement chunking strategies and stable chunk identifiers.
- Preserve document provenance and chunk-to-source mappings.
- Integrate preprocessing with document-ingestion workers.

### 4.4 — Qdrant

- Configure collections and payload indexes.
- Define dense and BM25 sparse-vector schemas.
- Implement vector insertion, updating, deletion, and metadata filtering interfaces.
- Create retrieval query interfaces.
- Prepare hybrid retrieval collections and indexing policies.

### 4.5 — Neo4j

- Design entity, concept, claim, document, and evidence nodes.
- Define relationship types and provenance properties.
- Implement graph repositories and traversal queries.
- Establish uniqueness constraints and graph-update strategies.
- Define entity and relationship extraction interfaces.

### 4.6 — Data Consistency

- Implement ingestion status transitions.
- Define cleanup behavior across PostgreSQL, Qdrant, Neo4j, and object storage.
- Implement reconciliation for partial indexing failures.
- Establish ownership-based isolation and deletion behavior.

### Deliverables

- Durable research and job persistence.
- Document-processing pipeline and durable metadata associations to Phase 2 MinIO objects.
- Qdrant collections and Neo4j graph schemas.
- Tested database repositories and retrieval interfaces.
- Checkpoint storage prepared for LangGraph integration.

**Exit criteria:** Documents and research metadata are persisted, ingestion stages execute through workers, and all storage systems support tested read/write operations.

**Dependency note:** Real model-generated embeddings and extracted graph knowledge will be connected in Phase 5. Phase 4 establishes the storage and indexing infrastructure, including fixtures for testing.

---

# Phase 5 — External Services & Tool Integrations

**Architecture Layer:** 07 / External Services

**Objective:** Integrate the external AI and information-retrieval capabilities needed for real research execution.

### 5.1 — External MCP/Skills for Web Search

**Mandatory architectural decision: Web search must use external MCP servers or skills-backed tool integrations.**

- Integrate external MCP servers for web search.
- Support external skills that expose search or web-retrieval capabilities through compatible tool adapters.
- Do not build a custom web search engine.
- Avoid provider-specific search logic inside LangGraph agent nodes.
- Implement standardized tool interfaces for search queries and source retrieval.
- Normalize search results into a shared evidence schema.
- Preserve URLs, titles, dates, source metadata, and provenance.
- Add tool authentication, timeout handling, and rate limits.

### 5.2 — LLM Integration

- Integrate model providers through LangChain.js-compatible adapters.
- Define models for planning, research, verification, and report generation.
- Implement structured outputs validated with Zod.
- Configure model parameters and execution budgets.
- Implement provider error handling and retry policies.

### 5.3 — Embeddings

- Connect embedding providers.
- Implement batch embedding generation.
- Connect embeddings to the Qdrant ingestion pipeline.
- Validate embedding dimensions and vector consistency.
- Support re-embedding and model-version tracking.

### 5.4 — Reranking

- Integrate a reranking model.
- Create a standardized reranking interface.
- Handle batch scoring, provider errors, and execution limits.
- Provide deterministic fallback behavior when reranking is unavailable.

### 5.5 — Knowledge Extraction

- Connect entity and relationship extraction to LLM services.
- Validate extracted entities, claims, and relationships.
- Write validated graph data into Neo4j.
- Link extracted knowledge to original documents and chunks.

### 5.6 — Guardrails

- Treat external sources and MCP tool responses as untrusted input.
- Implement tool permission boundaries and argument validation.
- Prevent retrieved content from being interpreted as higher-priority instructions.
- Apply sensitive-data handling and output validation.
- Establish external-tool execution budgets.

### 5.7 — Observability

- Integrate LangSmith tracing.
- Track model tokens, latency, approximate costs, and tool failures.
- Record retrieval and integration metrics.
- Build integration tests with mocked and real provider configurations.

### Deliverables

- Operational external MCP/Skills tool layer.
- Working LLM, embedding, and reranking integrations.
- Real document embedding and Qdrant indexing.
- LLM-based knowledge extraction connected to Neo4j.
- External service observability and safeguards.

**Exit criteria:** External research tools can retrieve real information, documents can be embedded and indexed, knowledge can be extracted, and model/tool integrations can be invoked reliably without the LangGraph orchestration layer.

---

# Phase 6 — AI Orchestration & Advanced Retrieval

**Architecture Layer:** 05 / AI Orchestration & Retrieval

**Objective:** Connect the completed infrastructure into an autonomous research system using LangGraph.js.

### 6.1 — LangGraph Foundation

- Define research graph state using JavaScript and Zod.
- Implement state transitions and conditional routing.
- Integrate PostgreSQL checkpointing.
- Support persistent conversation and research threads.
- Define execution limits and workflow termination conditions.

### 6.2 — Planning Agent

- Analyze user research questions.
- Decompose complex questions into subquestions.
- Develop research plans and retrieval strategies.
- Determine source requirements and research coverage objectives.

### 6.3 — Research Agent

- Select available research tools.
- Invoke external MCP/Skills for web search.
- Use local document retrieval and knowledge graph tools.
- Collect and organize research evidence.
- Support iterative retrieval when evidence is insufficient.

### 6.4 — Advanced Hybrid RAG

- Implement dense semantic retrieval using Qdrant.
- Implement BM25 sparse retrieval.
- Combine retrieval results using Reciprocal Rank Fusion (RRF).
- Integrate reranking.
- Add metadata filtering, deduplication, and contextual retrieval.
- Implement query expansion or reformulation.
- Integrate Neo4j graph traversal and relationship-aware evidence expansion.
- Assemble grounded contexts within token budgets.

### 6.5 — Evidence Evaluation

- Evaluate source relevance and evidence coverage.
- Identify missing information and conflicting claims.
- Decide whether further research is required.
- Enforce maximum research iterations and cost limits.

### 6.6 — Verification Agent

- Cross-reference factual claims.
- Distinguish supported, contradictory, and insufficient evidence.
- Verify that generated claims reference relevant retrieved evidence.
- Preserve uncertainty and evidence limitations.

### 6.7 — Report Agent

- Generate structured research reports.
- Produce comparative analysis when required.
- Include source-backed citations.
- Generate conclusions and recommendations with limitations.
- Persist reports, evidence references, and revisions.

### 6.8 — Human-in-the-Loop

- Introduce checkpointed approval interrupts.
- Allow research plan review and modification.
- Support workflow resumption after user feedback.
- Integrate cancellation and recovery with existing worker infrastructure.

### 6.9 — Agent Evaluation

- Test planning, routing, retrieval, and verification behavior.
- Evaluate retrieval relevance and citation accuracy.
- Test research loops, termination conditions, and provider failures.
- Measure report quality, latency, token usage, and execution cost.

### Deliverables

- Functional LangGraph research workflow.
- Advanced hybrid and graph-based RAG engine.
- Multi-stage research, verification, and synthesis.
- Persistent, interruptible, and resumable research sessions.
- Source-grounded reports and agent evaluation results.

**Exit criteria:** The complete backend can autonomously investigate a research question using real tools and stored knowledge, verify available evidence, generate a cited report, and resume interrupted workflows.

---

# Phase 7 — User Experience

**Architecture Layer:** 01 / User Experience

**Technology:** Next.js + Tailwind CSS

**Objective:** Build the complete research workspace after all core backend and AI capabilities are functioning.

### 7.1 — Frontend Foundation

- Develop the Next.js App Router application.
- Establish reusable Tailwind CSS components and design tokens.
- Implement authentication and workspace navigation.
- Connect frontend data access to the existing Bun API.

### 7.2 — Research Workspace

- Build research submission and configuration forms.
- Support research depth, source preferences, and execution budgets.
- Implement saved sessions, research history, and task management.
- Display live execution events through SSE.

### 7.3 — Research Execution Visualization

- Visualize research planning and agent stages.
- Display tool activity and discovered sources.
- Show progress, errors, retries, and execution status.
- Support cancellation and workflow resumption.

### 7.4 — Document & Knowledge Workspace

- Implement document upload and indexing-status interfaces.
- Display searchable source collections.
- Build the interactive Neo4j knowledge graph visualization.
- Allow navigation between entities, claims, documents, and supporting evidence.

### 7.5 — Report Workspace

- Render structured reports with clickable citations.
- Provide source inspection and evidence exploration.
- Display conflicting findings and research limitations.
- Support report editing, revision history, and section regeneration.
- Implement PDF and Markdown export.

### 7.6 — Human-in-the-Loop Interfaces

- Display research plan approval requests.
- Allow user feedback and workflow adjustments.
- Resume checkpointed research workflows through the API.

### 7.7 — Quality & Accessibility

- Implement loading and error states.
- Support responsive interfaces.
- Add keyboard accessibility and reduced-motion support.
- Test frontend integration, SSE behavior, and critical user journeys.

### Deliverables

- Complete Next.js research application.
- Integrated agent and retrieval workspaces.
- Live research dashboard.
- Knowledge graph explorer.
- Interactive evidence-backed reports.

**Exit criteria:** Users can submit research questions, upload documents, interact with autonomous research workflows, inspect evidence and graphs, and export completed reports through a fully functional web application.

---

# Project End — Final Integration & Release

**Objective:** Validate, optimize, document, and release EvidenceGraph.

### Final Activities

- Perform complete end-to-end testing.
- Verify authentication, authorization, and workspace isolation.
- Test failure recovery across API, queues, workers, agents, and databases.
- Benchmark retrieval and research performance.
- Evaluate research completeness, source relevance, and citation grounding.
- Review prompt-injection defenses and external-tool boundaries.
- Validate Docker deployment configurations.
- Finalize architecture and API documentation.
- Prepare the README, setup guide, demonstration, and evaluation report.

### Final Deliverable

A production-oriented, full-stack Agentic Deep Research Platform integrating:

- Autonomous LangGraph research workflows.
- Advanced dense/BM25 hybrid retrieval and reranking.
- Neo4j knowledge graph reasoning and evidence exploration.
- PostgreSQL-backed durable execution.
- Valkey/BullMQ asynchronous processing.
- External MCP/Skills-based web search.
- Next.js research and knowledge workspace.

**Project completion condition:** A reproducible, deployable application whose research results are source-grounded, whose execution is observable and recoverable, and whose core functionality is supported by automated tests and documented evaluations.
