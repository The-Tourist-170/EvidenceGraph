import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { IntegrationError } from "./errors.js";
import { createMcpClient, createMcpTransport } from "./mcp-client.js";
import {
  createRateLimiter,
  createWebSearchTool,
  extractToolPayload,
} from "./web-search.js";

const fixturePath = fileURLToPath(
  new URL("../test-fixtures/search-server.js", import.meta.url),
);
const cleanup = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    await cleanup
      .pop()()
      .catch(() => {});
  }
});

function baseConfig(overrides = {}) {
  return {
    transport: "stdio",
    tool: "web_search",
    queryField: "query",
    limitField: "limit",
    timeoutMs: 5_000,
    rateLimitPerMinute: 30,
    maxResults: 10,
    ...overrides,
  };
}

function createHttpFixture() {
  const server = new McpServer({
    name: "evidencegraph-fixture-http",
    version: "1.0.0",
  });
  server.registerTool(
    "web_search",
    {
      description: "HTTP fixture search.",
      inputSchema: {
        query: z.string(),
        limit: z.number().int().min(1).max(10).optional(),
      },
    },
    async ({ query }) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            results: [
              {
                title: `HTTP fixture for ${query}`,
                url: "https://fixture.example.test/http",
                snippet: "HTTP transport fixture.",
              },
            ],
          }),
        },
      ],
    }),
  );
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  return { server, transport };
}

describe("MCP transports", () => {
  test("connects over stdio and normalizes fixture search results", async () => {
    const config = baseConfig({
      command: process.execPath,
      args: [fixturePath],
    });
    const client = createMcpClient({ config });
    cleanup.push(() => client.close());
    const tools = await client.listTools();
    expect(tools.map(({ name }) => name)).toContain("web_search");

    const tool = createWebSearchTool({ config, client });
    const sources = await tool.search({ query: "urban heat", limit: 2 });
    expect(sources).toHaveLength(2);
    expect(sources[0]).toMatchObject({
      url: "https://fixture.example.test/a",
      trust: "untrusted",
      provenance: { provider: "mcp", tool: "web_search" },
    });
  });

  test("connects over Streamable HTTP and returns sources", async () => {
    const { server, transport } = createHttpFixture();
    await server.connect(transport);
    const httpServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) => transport.handleRequest(request),
    });
    cleanup.push(async () => {
      httpServer.stop(true);
      await server.close();
    });

    const config = baseConfig({
      transport: "http",
      url: `http://127.0.0.1:${httpServer.port}/mcp`,
    });
    const client = createMcpClient({ config });
    cleanup.push(() => client.close());
    const tool = createWebSearchTool({ config, client });
    const sources = await tool.search({ query: "restoration", limit: 1 });
    expect(sources).toHaveLength(1);
    expect(sources[0].url).toBe("https://fixture.example.test/http");
  });
});

describe("web search tool", () => {
  test("reports WEB_SEARCH_UNAVAILABLE when no MCP server is configured", async () => {
    const tool = createWebSearchTool({ config: null });
    expect(tool.available).toBe(false);
    await expect(tool.search({ query: "anything" })).rejects.toMatchObject({
      code: "WEB_SEARCH_UNAVAILABLE",
    });
  });

  test("enforces the configured request rate limit", async () => {
    let current = 0;
    const limiter = createRateLimiter({ limit: 1, now: () => current });
    const client = {
      async callTool() {
        return { structuredContent: { results: [{ url: "https://a.test" }] } };
      },
      async close() {},
      async listTools() {
        return [];
      },
    };
    const tool = createWebSearchTool({
      config: baseConfig(),
      client,
      rateLimiter: limiter,
      clock: () => current,
      now: () => new Date("2026-10-31T00:00:00.000Z"),
    });
    await tool.search({ query: "first query" });
    await expect(tool.search({ query: "second query" })).rejects.toMatchObject({
      code: "WEB_SEARCH_RATE_LIMITED",
    });
    current += 60_001;
    await expect(tool.search({ query: "third query" })).resolves.toHaveLength(
      1,
    );
  });

  test("classifies provider failures without leaking details", async () => {
    const client = {
      async callTool() {
        const error = new Error("raw provider detail");
        error.status = 429;
        throw error;
      },
      async close() {},
      async listTools() {
        return [];
      },
    };
    const tool = createWebSearchTool({ config: baseConfig(), client });
    const error = await tool
      .search({ query: "rate limited" })
      .catch((value) => value);
    expect(error).toBeInstanceOf(IntegrationError);
    expect(error.code).toBe("PROVIDER_RATE_LIMITED");
    expect(error.retryable).toBe(true);
    expect(error.message).not.toContain("raw provider detail");
  });

  test("classifies exhausted-credit failures as non-retryable", async () => {
    const client = {
      async callTool() {
        const error = new Error("paid model");
        error.status = 402;
        throw error;
      },
      async close() {},
      async listTools() {
        return [];
      },
    };
    const tool = createWebSearchTool({ config: baseConfig(), client });
    const error = await tool.search({ query: "credits test" }).catch((v) => v);
    expect(error.code).toBe("PROVIDER_INSUFFICIENT_CREDITS");
    expect(error.retryable).toBe(false);
  });

  test("passes the search token to stdio children under the configured variable", () => {
    const transport = createMcpTransport(
      baseConfig({
        command: "server",
        args: [],
        token: "secret-token",
        tokenEnv: "FIRECRAWL_API_KEY",
      }),
    );
    expect(transport._serverParams.env.FIRECRAWL_API_KEY).toBe("secret-token");
    expect(transport._serverParams.env.PATH).toBeTruthy();
  });

  test("omits configured fields that are empty strings", async () => {
    let received;
    const client = {
      async callTool(_name, args) {
        received = args;
        return { structuredContent: { results: [{ url: "https://a.test" }] } };
      },
      async close() {},
      async listTools() {
        return [];
      },
    };
    const tool = createWebSearchTool({
      config: baseConfig({ limitField: "", tool: "firecrawl_search" }),
      client,
    });
    await tool.search({ query: "field omission probe" });
    expect(received).toEqual({ query: "field omission probe" });
  });

  test("extracts structured and text payloads", () => {
    expect(extractToolPayload({ structuredContent: { results: [] } })).toEqual({
      results: [],
    });
    expect(
      extractToolPayload({
        content: [
          { type: "text", text: '{"results":[{"url":"https://a.test"}]}' },
        ],
      }),
    ).toEqual({ results: [{ url: "https://a.test" }] });
    try {
      extractToolPayload({ content: [] });
      throw new Error("Expected an invalid payload.");
    } catch (error) {
      expect(error.code).toBe("WEB_SEARCH_INVALID_RESULT");
    }
  });
});
