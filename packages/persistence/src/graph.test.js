import { describe, expect, test } from "bun:test";
import { createNeo4jRepository } from "./graph.js";

function createDriver() {
  const statements = [];
  const session = {
    async run(statement, parameters = {}) {
      statements.push({ statement, parameters });
      return { records: [] };
    },
    async executeWrite(callback) {
      return callback(this);
    },
    async close() {},
  };
  return {
    statements,
    session: () => session,
    async verifyConnectivity() {},
    async close() {},
  };
}

const config = {
  uri: "bolt://localhost:7688",
  username: "neo4j",
  password: "local-dev-password",
};
const document = {
  id: "00000000-0000-4000-8000-000000000001",
  userId: "user-a",
  workspaceId: "workspace-a",
  filename: "report.pdf",
  mediaType: "application/pdf",
};

describe("Neo4j graph repository", () => {
  test("creates idempotent graph constraints and parameterized document nodes", async () => {
    const driver = createDriver();
    const repository = createNeo4jRepository({ config, driver });
    await repository.initialize();
    await repository.upsertDocument(document);

    expect(driver.statements[0].statement).toContain("CREATE CONSTRAINT");
    expect(driver.statements.at(-1).statement).toContain("$workspaceId");
    expect(driver.statements.at(-1).parameters).toEqual(document);
  });

  test("upserts fixture entities and scopes graph traversal to a workspace", async () => {
    const driver = createDriver();
    const repository = createNeo4jRepository({ config, driver });
    const entity = {
      id: "00000000-0000-4000-8000-000000000002",
      name: "Climate",
      normalizedName: "climate",
      kind: "concept",
    };
    await repository.upsertEntities({
      documentId: document.id,
      workspaceId: document.workspaceId,
      entities: [entity],
    });
    await repository.getDocumentEntities({
      documentId: document.id,
      workspaceId: document.workspaceId,
      limit: 12,
    });

    const writes = driver.statements.filter(({ statement }) =>
      statement.includes("MERGE"),
    );
    expect(writes.at(-1).parameters.entities).toEqual([entity]);
    expect(driver.statements.at(-1).parameters.workspaceId).toBe(
      document.workspaceId,
    );
  });

  test("rejects malformed entities and deletes only the requested owner-scoped document", async () => {
    const driver = createDriver();
    const repository = createNeo4jRepository({ config, driver });
    await expect(
      repository.upsertEntities({
        documentId: document.id,
        workspaceId: document.workspaceId,
        entities: [{ ...document, name: "bad" }],
      }),
    ).rejects.toThrow();
    await repository.deleteDocument({
      documentId: document.id,
      workspaceId: document.workspaceId,
      userId: document.userId,
    });
    const documentDelete = driver.statements.find(({ statement }) =>
      statement.includes("DETACH DELETE d"),
    );
    expect(documentDelete.parameters).toEqual({
      documentId: document.id,
      workspaceId: document.workspaceId,
      userId: document.userId,
    });
    expect(documentDelete.statement).toContain("$userId");
  });

  test("upserts validated claims and relationships with provenance", async () => {
    const driver = createDriver();
    const repository = createNeo4jRepository({ config, driver });
    const claim = {
      id: "00000000-0000-4000-8000-000000000003",
      text: "Urban trees reduce summer heat.",
      normalizedText: "urban trees reduce summer heat",
      confidence: 0.9,
      chunkId: "00000000-0000-4000-8000-000000000004",
    };
    const relationship = {
      from: "urban trees",
      to: "summer heat",
      type: "REDUCES",
      confidence: 0.8,
    };
    await repository.upsertClaims({
      documentId: document.id,
      workspaceId: document.workspaceId,
      claims: [claim],
    });
    await repository.upsertRelationships({
      workspaceId: document.workspaceId,
      relationships: [relationship],
    });

    const claimWrite = driver.statements.find(({ statement }) =>
      statement.includes("MERGE (c:EvidenceClaim"),
    );
    const relationshipWrite = driver.statements.find(({ statement }) =>
      statement.includes("RELATED_TO"),
    );
    expect(claimWrite.parameters.claims).toEqual([claim]);
    expect(relationshipWrite.parameters.relationships).toEqual([relationship]);

    await expect(
      repository.upsertClaims({
        documentId: document.id,
        workspaceId: document.workspaceId,
        claims: [{ ...claim, id: "not-a-uuid" }],
      }),
    ).rejects.toThrow();
  });
});
