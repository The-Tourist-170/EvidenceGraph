import { z } from "zod";
import { getMcpSearchConfig } from "@evidencegraph/config";
import { normalizeWebResults } from "./evidence.js";
import { classifyProviderError, IntegrationError } from "./errors.js";
import { createMcpClient } from "./mcp-client.js";

const searchArgumentsSchema = z
  .object({
    query: z.string().min(3).max(2_000),
    limit: z.number().int().min(1).max(50),
  })
  .strict();

export function createRateLimiter({
  limit,
  windowMs = 60_000,
  now = () => Date.now(),
}) {
  let windowStart = now();
  let used = 0;
  return function take() {
    const current = now();
    if (current - windowStart >= windowMs) {
      windowStart = current;
      used = 0;
    }
    if (used >= limit) {
      throw new IntegrationError(
        "WEB_SEARCH_RATE_LIMITED",
        "The web-search rate limit was reached.",
        { retryable: true },
      );
    }
    used += 1;
  };
}

export function extractToolPayload(result) {
  if (result && typeof result === "object") {
    if (result.structuredContent) return result.structuredContent;
    if (Array.isArray(result.content)) {
      const text = result.content
        .filter(
          (item) => item?.type === "text" && typeof item.text === "string",
        )
        .map((item) => item.text)
        .join("\n")
        .trim();
      if (text) {
        try {
          return JSON.parse(text);
        } catch {
          throw new IntegrationError(
            "WEB_SEARCH_INVALID_RESULT",
            "The web-search tool returned unparsable text.",
          );
        }
      }
    }
  }
  throw new IntegrationError(
    "WEB_SEARCH_INVALID_RESULT",
    "The web-search tool returned an unsupported result shape.",
  );
}

export function createWebSearchTool({
  config = getMcpSearchConfig(),
  client,
  metrics,
  now = () => new Date(),
  rateLimiter,
  clock = () => Date.now(),
} = {}) {
  if (!config) {
    return {
      available: false,
      async search() {
        throw new IntegrationError(
          "WEB_SEARCH_UNAVAILABLE",
          "No MCP web-search server is configured.",
        );
      },
      async close() {},
      async listTools() {
        return [];
      },
    };
  }

  const mcp = client ?? createMcpClient({ config });
  const take =
    rateLimiter ??
    createRateLimiter({
      limit: config.rateLimitPerMinute,
      now: clock,
    });

  async function search({ query, limit = config.maxResults, signal } = {}) {
    const parsed = searchArgumentsSchema.parse({ query, limit });
    take();
    const timeoutSignal = AbortSignal.timeout(config.timeoutMs);
    const combined = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;
    const started = performance.now();
    try {
      const result = await mcp.callTool(
        config.tool,
        {
          [config.queryField]: parsed.query,
          [config.limitField]: parsed.limit,
        },
        { timeout: config.timeoutMs, signal: combined },
      );
      const sources = normalizeWebResults(extractToolPayload(result), {
        provider: "mcp",
        tool: config.tool,
        retrievedAt: now().toISOString(),
        maxResults: parsed.limit,
      });
      metrics?.recordCall({
        operation: "web_search",
        durationMs: performance.now() - started,
        ok: true,
      });
      return sources;
    } catch (error) {
      const classified =
        error instanceof z.ZodError
          ? new IntegrationError(
              "WEB_SEARCH_ARGUMENTS_INVALID",
              "The web-search request arguments were invalid.",
              { cause: error },
            )
          : classifyProviderError(error, { operation: "Web search" });
      metrics?.recordCall({
        operation: "web_search",
        durationMs: performance.now() - started,
        ok: false,
        code: classified.code,
      });
      throw classified;
    }
  }

  return {
    available: true,
    close: () => mcp.close(),
    listTools: () => mcp.listTools(),
    search,
  };
}
