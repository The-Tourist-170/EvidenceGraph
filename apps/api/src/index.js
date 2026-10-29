import { getRuntimeConfig } from "@evidencegraph/config";
import { logger } from "@evidencegraph/shared";

/**
 * @param {Request} request
 * @returns {Response}
 */
export function handleRequest(request) {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/health") {
    return Response.json({ status: "ok" });
  }

  return new Response("Not Found", { status: 404 });
}

if (import.meta.main) {
  const config = getRuntimeConfig();
  const server = Bun.serve({
    port: config.PORT,
    fetch: handleRequest,
  });

  logger.info("API server started", { port: server.port });
}
