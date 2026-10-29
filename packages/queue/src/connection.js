import { getValkeyConfig } from "@evidencegraph/config";
import { logger } from "@evidencegraph/shared";
import Redis from "ioredis";

export function createValkeyConnection(config = getValkeyConfig()) {
  const connection = new Redis(config.url, {
    password: config.password,
    connectTimeout: 5_000,
    enableReadyCheck: true,
    maxRetriesPerRequest: null,
    retryStrategy(attempt) {
      return Math.min(attempt * 250, 5_000);
    },
  });
  connection.on("error", () => logger.error("Valkey connection error"));
  return connection;
}
