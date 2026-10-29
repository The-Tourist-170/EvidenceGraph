import {
  getMinioConfig,
  getRuntimeConfig,
  getValkeyConfig,
} from "@evidencegraph/config";
import { logger } from "@evidencegraph/shared";
import { createObjectStorage } from "@evidencegraph/object-storage";
import { createBullMqStore, createQueueRuntime } from "@evidencegraph/queue";
import { createApiHandler } from "./app.js";

export { createApiHandler };

async function startApi() {
  const runtimeConfig = getRuntimeConfig();
  const queueRuntime = createQueueRuntime(getValkeyConfig());
  const objectStorage = createObjectStorage({ config: getMinioConfig() });
  const store = createBullMqStore({ runtime: queueRuntime, objectStorage });

  try {
    await Promise.all([store.initialize(), objectStorage.initialize()]);
    const server = Bun.serve({
      port: runtimeConfig.PORT,
      idleTimeout: 60,
      fetch: createApiHandler({ store }),
    });
    logger.info("API server started", { port: server.port });

    let shutdownPromise;
    const shutdown = () => {
      if (!shutdownPromise) {
        shutdownPromise = (async () => {
          server.stop(true);
          await store.close();
          logger.info("API server stopped");
        })();
      }
      return shutdownPromise;
    };
    process.once("SIGINT", () => void shutdown());
    process.once("SIGTERM", () => void shutdown());
  } catch (error) {
    await store.close().catch(() => {});
    logger.error("API startup failed", {
      message:
        error instanceof Error ? error.message : "Unknown startup error.",
    });
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await startApi();
}
