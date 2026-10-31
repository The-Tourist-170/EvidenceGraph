import { z } from "zod";
import { QdrantClient } from "@qdrant/js-client-rest";
import { getQdrantConfig } from "@evidencegraph/config";

export const defaultCollectionName = "evidencegraph_chunks";

const densePointSchema = z
  .object({
    id: z.string().uuid(),
    dense: z.array(z.number().finite()).min(1),
    payload: z
      .object({
        workspaceId: z.string().min(1),
        userId: z.string().min(1),
        documentId: z.string().uuid(),
        chunkId: z.string().uuid(),
        content: z.string().min(1),
        metadata: z.record(z.unknown()).default({}),
      })
      .strict(),
    sparse: z
      .object({
        indices: z.array(z.number().int().nonnegative()),
        values: z.array(z.number().finite()),
      })
      .strict()
      .optional(),
  })
  .strict();

function tenantFilter(workspaceId, userId) {
  return {
    must: [
      { key: "workspaceId", match: { value: workspaceId } },
      { key: "userId", match: { value: userId } },
    ],
  };
}

export function createQdrantRepository({
  config = getQdrantConfig(),
  client,
  collectionName = defaultCollectionName,
} = {}) {
  const qdrant =
    client ?? new QdrantClient({ url: config.url, apiKey: config.apiKey });

  async function ensureCollection() {
    const status = await qdrant.collectionExists(collectionName);
    if (!status.exists) {
      await qdrant.createCollection(collectionName, {
        vectors: {
          dense: { size: config.dimensions, distance: "Cosine" },
        },
        sparse_vectors: { bm25: {} },
      });
    }
    await Promise.all([
      qdrant.createPayloadIndex(collectionName, {
        field_name: "workspaceId",
        field_schema: "keyword",
      }),
      qdrant.createPayloadIndex(collectionName, {
        field_name: "userId",
        field_schema: "keyword",
      }),
      qdrant.createPayloadIndex(collectionName, {
        field_name: "documentId",
        field_schema: "keyword",
      }),
    ]);
    return true;
  }

  async function checkHealth() {
    await qdrant.getCollections();
    return true;
  }

  async function upsertPoints(points) {
    const parsed = z.array(densePointSchema).min(1).parse(points);
    for (const point of parsed) {
      if (point.dense.length !== config.dimensions) {
        throw new Error(
          `Dense vector dimension mismatch: expected ${config.dimensions}.`,
        );
      }
      if (
        point.sparse &&
        point.sparse.indices.length !== point.sparse.values.length
      ) {
        throw new Error(
          "Sparse vector indices and values must have equal length.",
        );
      }
    }
    await qdrant.upsert(collectionName, {
      wait: true,
      points: parsed.map((point) => ({
        id: point.id,
        vector: {
          dense: point.dense,
          ...(point.sparse ? { bm25: point.sparse } : {}),
        },
        payload: point.payload,
      })),
    });
  }

  async function searchDense({ vector, workspaceId, userId, limit = 10 }) {
    const denseVector = z
      .array(z.number().finite())
      .length(config.dimensions)
      .parse(vector);
    return qdrant.search(collectionName, {
      vector: { name: "dense", vector: denseVector },
      filter: tenantFilter(workspaceId, userId),
      limit: z.number().int().min(1).max(100).parse(limit),
      with_payload: true,
    });
  }

  async function searchSparse({ vector, workspaceId, userId, limit = 10 }) {
    const sparse = densePointSchema.shape.sparse.unwrap().parse(vector);
    if (sparse.indices.length !== sparse.values.length) {
      throw new Error(
        "Sparse vector indices and values must have equal length.",
      );
    }
    return qdrant.search(collectionName, {
      vector: { name: "bm25", vector: sparse },
      filter: tenantFilter(workspaceId, userId),
      limit: z.number().int().min(1).max(100).parse(limit),
      with_payload: true,
    });
  }

  async function searchHybrid({
    denseVector,
    sparseVector,
    workspaceId,
    userId,
    limit = 10,
    candidateLimit = Math.max(limit * 3, 30),
  }) {
    const denseResults = await searchDense({
      vector: denseVector,
      workspaceId,
      userId,
      limit: candidateLimit,
    });
    if (!sparseVector) return denseResults.slice(0, limit);
    const sparseResults = await searchSparse({
      vector: sparseVector,
      workspaceId,
      userId,
      limit: candidateLimit,
    });
    return reciprocalRankFusion([denseResults, sparseResults], { limit });
  }

  async function deleteDocument({ documentId, workspaceId, userId }) {
    const id = z.string().uuid().parse(documentId);
    await qdrant.delete(collectionName, {
      wait: true,
      filter: {
        must: [
          { key: "documentId", match: { value: id } },
          {
            key: "workspaceId",
            match: { value: z.string().min(1).parse(workspaceId) },
          },
          { key: "userId", match: { value: z.string().min(1).parse(userId) } },
        ],
      },
    });
  }

  return {
    checkHealth,
    close() {},
    deleteDocument,
    ensureCollection,
    searchDense,
    searchHybrid,
    searchSparse,
    upsertPoints,
  };
}

export function createSparseVector(text) {
  const tokens = String(text ?? "")
    .toLowerCase()
    .normalize("NFKC")
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1);
  const counts = new Map();
  for (const token of tokens) {
    let hash = 2_166_136_261;
    for (let index = 0; index < token.length; index += 1) {
      hash ^= token.charCodeAt(index);
      hash = Math.imul(hash, 16_777_619);
    }
    const term = (hash >>> 0) % 2_147_483_647;
    counts.set(term, (counts.get(term) ?? 0) + 1);
  }
  const indices = [...counts.keys()].sort((a, b) => a - b);
  return {
    indices,
    values: indices.map((index) => Math.log1p(counts.get(index))),
  };
}

export function reciprocalRankFusion(resultLists, { k = 60, limit } = {}) {
  const scores = new Map();
  const points = new Map();
  for (const results of resultLists) {
    results.forEach((point, index) => {
      const id = String(point.id);
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1));
      if (!points.has(id)) points.set(id, point);
    });
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit ?? Number.POSITIVE_INFINITY)
    .map(([id, score]) => ({ ...points.get(id), id, rrfScore: score }));
}
