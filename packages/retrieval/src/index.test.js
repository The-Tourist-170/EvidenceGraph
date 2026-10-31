import { describe, expect, test } from "bun:test";
import { createQdrantRepository } from "./index.js";

function createClient() {
  const calls = [];
  return {
    calls,
    async collectionExists(name) {
      calls.push(["collectionExists", name]);
      return { exists: false };
    },
    async createCollection(name, config) {
      calls.push(["createCollection", name, config]);
      return true;
    },
    async createPayloadIndex(name, config) {
      calls.push(["createPayloadIndex", name, config]);
      return true;
    },
    async getCollections() {
      return { collections: [] };
    },
    async upsert(name, config) {
      calls.push(["upsert", name, config]);
      return { status: "completed" };
    },
    async search(name, config) {
      calls.push(["search", name, config]);
      return [{ id: "fixture" }];
    },
    async delete(name, config) {
      calls.push(["delete", name, config]);
      return { status: "completed" };
    },
  };
}

const config = { url: "http://localhost:6335", dimensions: 2 };
const owner = { workspaceId: "workspace-1", userId: "user-1" };
const documentId = "00000000-0000-4000-8000-000000000001";
const point = {
  id: "00000000-0000-4000-8000-000000000002",
  dense: [0.25, 0.75],
  sparse: { indices: [1, 3], values: [0.4, 0.6] },
  payload: {
    ...owner,
    documentId,
    chunkId: "00000000-0000-4000-8000-000000000003",
    content: "Fixture evidence chunk.",
    metadata: { chunkIndex: 0 },
  },
};

describe("Qdrant repository", () => {
  test("creates named dense/sparse collections and ownership indexes", async () => {
    const client = createClient();
    const repository = createQdrantRepository({ client, config });

    await repository.ensureCollection();

    const create = client.calls.find(([name]) => name === "createCollection");
    expect(create[2].vectors.dense).toEqual({ size: 2, distance: "Cosine" });
    expect(create[2].sparse_vectors).toHaveProperty("bm25");
    expect(
      client.calls.filter(([name]) => name === "createPayloadIndex"),
    ).toHaveLength(3);
  });

  test("upserts supplied vectors and applies workspace/user filters to search", async () => {
    const client = createClient();
    const repository = createQdrantRepository({ client, config });
    await repository.upsertPoints([point]);
    await repository.searchDense({ vector: [0.25, 0.75], ...owner, limit: 5 });
    await repository.searchSparse({ vector: point.sparse, ...owner, limit: 5 });

    expect(
      client.calls.find(([name]) => name === "upsert")[2].points[0].vector,
    ).toEqual({
      dense: [0.25, 0.75],
      bm25: point.sparse,
    });
    const searches = client.calls.filter(([name]) => name === "search");
    expect(searches).toHaveLength(2);
    expect(searches[0][2].filter.must).toEqual([
      { key: "workspaceId", match: { value: owner.workspaceId } },
      { key: "userId", match: { value: owner.userId } },
    ]);
  });

  test("rejects vector dimension mismatches and deletes only owned document points", async () => {
    const client = createClient();
    const repository = createQdrantRepository({ client, config });
    await expect(
      repository.upsertPoints([{ ...point, dense: [1] }]),
    ).rejects.toThrow("Dense vector dimension mismatch");
    await repository.deleteDocument({ documentId, ...owner });
    const deletion = client.calls.find(([name]) => name === "delete");
    expect(deletion[2].filter.must).toHaveLength(3);
  });
});
