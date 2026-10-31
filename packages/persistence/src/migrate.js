import { getDatabaseConfig } from "@evidencegraph/config";
import { createPostgresDatabase } from "./database.js";
import { createPostgresTaskRepository } from "./repository.js";

const config = getDatabaseConfig();
const database = createPostgresDatabase({ config });
const repository = createPostgresTaskRepository({
  database,
  env: process.env,
});

try {
  await database.migrate();
  if (process.env.NODE_ENV !== "production") {
    await repository.ensureOwner({
      userId: "local-user",
      workspaceId: "local-workspace",
    });
  }
  console.info("Database migrations completed.");
} finally {
  await database.close();
}
