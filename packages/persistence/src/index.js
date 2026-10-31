import {
  getDatabaseConfig,
  getNeo4jConfig,
  getQdrantConfig,
} from "@evidencegraph/config";
import { createQdrantRepository } from "@evidencegraph/retrieval";
import { createPostgresDatabase } from "./database.js";
import { createNeo4jRepository } from "./graph.js";
import { createPostgresTaskRepository } from "./repository.js";

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

  async function initialize(options) {
    await metadata.initialize(options);
    await Promise.all([
      graphRepository.initialize(),
      vectorRepository.ensureCollection(),
    ]);
  }

  async function checkComponents() {
    const results = await Promise.allSettled([
      database.checkHealth(),
      vectorRepository.checkHealth(),
      graphRepository.checkHealth(),
    ]);
    return {
      postgres: results[0].status === "fulfilled" ? "ready" : "unavailable",
      qdrant: results[1].status === "fulfilled" ? "ready" : "unavailable",
      neo4j: results[2].status === "fulfilled" ? "ready" : "unavailable",
    };
  }

  async function deleteDocumentIndexes({ documentId, workspaceId, userId }) {
    await Promise.all([
      vectorRepository.deleteDocument({ documentId, workspaceId, userId }),
      graphRepository.deleteDocument({ documentId, workspaceId, userId }),
    ]);
  }

  async function close() {
    const results = await Promise.allSettled([
      graphRepository.close(),
      vectorRepository.close(),
      metadata.close(),
    ]);
    const failure = results.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
  }

  return {
    ...metadata,
    checkComponents,
    close,
    database,
    deleteDocumentIndexes,
    graphRepository,
    initialize,
    vectorRepository,
  };
}

export { createPostgresDatabase } from "./database.js";
export { createNeo4jRepository } from "./graph.js";
export { createPostgresTaskRepository } from "./repository.js";
export * from "./schema.js";
