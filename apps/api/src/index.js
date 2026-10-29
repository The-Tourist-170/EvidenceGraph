import { getRuntimeConfig } from "@evidencegraph/config";
import { logger } from "@evidencegraph/shared";
import { createApiHandler } from "./app.js";

export const handleRequest = createApiHandler();

if (import.meta.main) {
  const config = getRuntimeConfig();
  const server = Bun.serve({
    port: config.PORT,
    fetch: handleRequest,
  });

  logger.info("API server started", { port: server.port });
}
