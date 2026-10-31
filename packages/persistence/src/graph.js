import neo4j from "neo4j-driver";
import { getNeo4jConfig } from "@evidencegraph/config";
import { z } from "zod";

const documentInputSchema = z
  .object({
    id: z.string().uuid(),
    userId: z.string().min(1),
    workspaceId: z.string().min(1),
    filename: z.string().min(1).max(128),
    mediaType: z.string().min(1),
  })
  .strict();

const entityInputSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1).max(256),
    normalizedName: z.string().min(1).max(256),
    kind: z.string().min(1).max(80),
  })
  .strict();

export function createNeo4jRepository({
  config = getNeo4jConfig(),
  driver,
} = {}) {
  const graph =
    driver ??
    neo4j.driver(
      config.uri,
      neo4j.auth.basic(config.username, config.password),
    );

  async function initialize() {
    const session = graph.session();
    try {
      await session.run(
        "CREATE CONSTRAINT evidence_document_id IF NOT EXISTS FOR (d:EvidenceDocument) REQUIRE d.id IS UNIQUE",
      );
      await session.run(
        "CREATE CONSTRAINT evidence_entity_workspace_name IF NOT EXISTS FOR (e:EvidenceEntity) REQUIRE (e.workspaceId, e.normalizedName) IS UNIQUE",
      );
    } finally {
      await session.close();
    }
  }

  async function checkHealth() {
    await graph.verifyConnectivity();
    return true;
  }

  async function upsertDocument(document) {
    const value = documentInputSchema.parse(document);
    const session = graph.session();
    try {
      await session.run(
        "MERGE (d:EvidenceDocument {id: $id}) SET d.userId = $userId, d.workspaceId = $workspaceId, d.filename = $filename, d.mediaType = $mediaType, d.updatedAt = datetime()",
        value,
      );
    } finally {
      await session.close();
    }
  }

  async function upsertEntities({ documentId, workspaceId, entities }) {
    const id = z.string().uuid().parse(documentId);
    const workspace = z.string().min(1).parse(workspaceId);
    const parsedEntities = z.array(entityInputSchema).max(500).parse(entities);
    if (parsedEntities.length === 0) return;
    const session = graph.session();
    try {
      await session.executeWrite(async (transaction) => {
        await transaction.run(
          "MATCH (d:EvidenceDocument {id: $documentId, workspaceId: $workspaceId}) UNWIND $entities AS entity MERGE (e:EvidenceEntity {workspaceId: $workspaceId, normalizedName: entity.normalizedName}) SET e.name = entity.name, e.kind = entity.kind, e.id = entity.id MERGE (d)-[:MENTIONS]->(e)",
          { documentId: id, workspaceId: workspace, entities: parsedEntities },
        );
      });
    } finally {
      await session.close();
    }
  }

  async function getDocumentEntities({ documentId, workspaceId, limit = 100 }) {
    const id = z.string().uuid().parse(documentId);
    const workspace = z.string().min(1).parse(workspaceId);
    const boundedLimit = z.number().int().min(1).max(500).parse(limit);
    const session = graph.session();
    try {
      const result = await session.run(
        "MATCH (d:EvidenceDocument {id: $documentId, workspaceId: $workspaceId})-[:MENTIONS]->(e:EvidenceEntity) RETURN e.id AS id, e.name AS name, e.kind AS kind ORDER BY e.name LIMIT $limit",
        {
          documentId: id,
          workspaceId: workspace,
          limit: neo4j.int(boundedLimit),
        },
      );
      return result.records.map((record) => ({
        id: record.get("id"),
        name: record.get("name"),
        kind: record.get("kind"),
      }));
    } finally {
      await session.close();
    }
  }

  async function deleteDocument({ documentId, workspaceId, userId }) {
    const id = z.string().uuid().parse(documentId);
    const workspace = z.string().min(1).parse(workspaceId);
    const user = z.string().min(1).parse(userId);
    const session = graph.session();
    try {
      await session.executeWrite(async (transaction) => {
        await transaction.run(
          "MATCH (d:EvidenceDocument {id: $documentId, workspaceId: $workspaceId, userId: $userId}) DETACH DELETE d",
          { documentId: id, workspaceId: workspace, userId: user },
        );
        await transaction.run(
          "MATCH (e:EvidenceEntity {workspaceId: $workspaceId}) WHERE NOT (e)--() DETACH DELETE e",
          { workspaceId: workspace },
        );
      });
    } finally {
      await session.close();
    }
  }

  return {
    checkHealth,
    close: () => graph.close(),
    deleteDocument,
    getDocumentEntities,
    initialize,
    upsertDocument,
    upsertEntities,
  };
}
