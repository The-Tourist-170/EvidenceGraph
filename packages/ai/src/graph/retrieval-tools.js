import { createSparseVector } from "@evidencegraph/retrieval";
import { evidenceSourceSchema } from "../evidence.js";
import { asUntrustedData, sanitizeUntrustedText } from "../guardrails.js";
import { retrievedChunkSchema } from "./state.js";

function chunkFromPoint(point) {
  const payload = point?.payload ?? {};
  if (
    typeof payload.chunkId !== "string" ||
    typeof payload.documentId !== "string" ||
    typeof payload.content !== "string"
  ) {
    return null;
  }
  try {
    return retrievedChunkSchema.parse({
      chunkId: payload.chunkId,
      documentId: payload.documentId,
      content: payload.content,
      score: point.rrfScore ?? point.score ?? 0,
      metadata: payload.metadata ?? {},
    });
  } catch {
    return null;
  }
}

export function createRetrievalTools({
  vectorRepository,
  embeddings,
  reranker,
  graphRepository,
  now = () => new Date(),
} = {}) {
  async function expandGraph({ owner, chunks, limit = 50, signal }) {
    if (!graphRepository || chunks.length === 0) return null;
    const documentIds = [
      ...new Set(chunks.map((chunk) => chunk.documentId)),
    ].slice(0, 5);
    try {
      const entities = [];
      for (const documentId of documentIds) {
        const found = await graphRepository.getDocumentEntities({
          documentId,
          workspaceId: owner.workspaceId,
          limit,
        });
        entities.push(
          ...found.map((entity) => ({
            id: entity.id,
            name: entity.name,
            kind: entity.kind,
          })),
        );
      }
      const relationships = await graphRepository.getDocumentRelationships({
        workspaceId: owner.workspaceId,
        limit,
      });
      const deduped = new Map();
      for (const entity of entities) {
        if (!deduped.has(entity.name)) deduped.set(entity.name, entity);
      }
      signal?.throwIfAborted?.();
      return {
        entities: [...deduped.values()].slice(0, limit),
        relationships: relationships.slice(0, limit),
      };
    } catch {
      return null;
    }
  }

  async function retrieve({ queries, owner, limit = 10, signal } = {}) {
    if (!vectorRepository || !embeddings) {
      return { sources: [], chunks: [], graphEvidence: null };
    }
    const uniqueQueries = [...new Set(queries.filter(Boolean))].slice(0, 3);
    const candidates = new Map();
    for (const query of uniqueQueries) {
      signal?.throwIfAborted?.();
      const denseVector = await embeddings.embedQuery(query, { signal });
      const points = await vectorRepository.searchHybrid({
        denseVector,
        sparseVector: createSparseVector(query),
        workspaceId: owner.workspaceId,
        userId: owner.userId,
        limit,
      });
      for (const point of points) {
        const chunk = chunkFromPoint(point);
        if (!chunk) continue;
        const current = candidates.get(chunk.chunkId);
        if (!current || chunk.score > current.score) {
          candidates.set(chunk.chunkId, chunk);
        }
      }
    }
    let ordered = [...candidates.values()];
    if (ordered.length > 0 && reranker) {
      const reranked = await reranker.rerank({
        query: uniqueQueries[0] ?? "",
        documents: ordered.map((chunk) => ({
          id: chunk.chunkId,
          text: chunk.content,
        })),
        limit: ordered.length,
      });
      const order = new Map(
        reranked.results.map((result, index) => [result.id, index]),
      );
      ordered = ordered
        .map((chunk) => ({
          chunk,
          rank: order.get(chunk.chunkId) ?? Number.MAX_SAFE_INTEGER,
        }))
        .sort((a, b) => a.rank - b.rank || b.chunk.score - a.chunk.score)
        .map(({ chunk }) => chunk);
    }
    const selected = ordered.slice(0, limit);
    const sources = selected.map((chunk) =>
      evidenceSourceSchema.parse({
        sourceId: chunk.chunkId,
        url: `local://evidence/${chunk.documentId}/${chunk.chunkId}`,
        title:
          sanitizeUntrustedText(String(chunk.metadata.filename ?? ""), {
            maxLength: 512,
          }) || `Document ${chunk.documentId}`,
        snippet: sanitizeUntrustedText(chunk.content, { maxLength: 2_000 }),
        trust: "untrusted",
        provenance: {
          provider: "local",
          tool: "hybrid_retrieval",
          retrievedAt: now().toISOString(),
        },
      }),
    );
    const graphEvidence = await expandGraph({
      owner,
      chunks: selected,
      signal,
    });
    return { sources, chunks: selected, graphEvidence };
  }

  return { expandGraph, retrieve };
}

export function assembleContext({
  sources = [],
  chunks = [],
  graphEvidence = null,
  maxTokens = 6_000,
}) {
  const blocks = [];
  let usedTokens = 0;
  const sourceIds = [];
  const chunkIds = [];

  function push(block) {
    const remainingCharacters = Math.max(0, (maxTokens - usedTokens) * 4);
    if (remainingCharacters < 80) return false;
    const text =
      block.length > remainingCharacters
        ? `${block.slice(0, remainingCharacters - 32)}\n[truncated]\n</untrusted-data>`
        : block;
    blocks.push(text);
    usedTokens += Math.ceil(text.length / 4);
    return true;
  }

  for (const source of sources) {
    if (
      !push(
        asUntrustedData(
          source.sourceId,
          `Title: ${source.title}\nURL: ${source.url}\nSnippet: ${source.snippet}`,
        ),
      )
    ) {
      break;
    }
    sourceIds.push(source.sourceId);
  }
  for (const chunk of chunks) {
    if (
      !push(
        asUntrustedData(
          chunk.chunkId,
          `Document: ${chunk.documentId}\nContent: ${chunk.content}`,
        ),
      )
    ) {
      break;
    }
    chunkIds.push(chunk.chunkId);
  }
  if (graphEvidence) {
    const lines = [
      ...graphEvidence.entities.map(
        (entity) => `Entity: ${entity.name} (${entity.kind})`,
      ),
      ...graphEvidence.relationships.map(
        (relationship) =>
          `Relationship: ${relationship.from} -[${relationship.type}]-> ${relationship.to}`,
      ),
    ];
    if (lines.length > 0) {
      push(asUntrustedData("knowledge-graph", lines.join("\n")));
    }
  }
  return {
    text: blocks.join("\n\n"),
    usedTokens,
    sourceIds,
    chunkIds,
  };
}
