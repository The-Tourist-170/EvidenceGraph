import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "evidencegraph-fixture-search",
  version: "1.0.0",
});

server.registerTool(
  "web_search",
  {
    description: "Fixture web search used by the Phase 5 integration tests.",
    inputSchema: {
      query: z.string(),
      limit: z.number().int().min(1).max(10).optional(),
    },
  },
  async ({ query, limit }) => {
    const results = [
      {
        title: `Fixture result for ${query}`,
        url: "https://fixture.example.test/a",
        snippet: "First fixture snippet.",
        publishedAt: "2026-01-02",
      },
      {
        title: "Second fixture result",
        url: "https://fixture.example.test/b",
        snippet: "Second fixture snippet.",
      },
    ].slice(0, limit ?? 2);
    return {
      content: [{ type: "text", text: JSON.stringify({ results }) }],
    };
  },
);

await server.connect(new StdioServerTransport());
