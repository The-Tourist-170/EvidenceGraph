import { describe, expect, test } from "bun:test";
import { normalizeWebResults, stableSourceId } from "./evidence.js";
import { IntegrationError } from "./errors.js";

const context = {
  provider: "mcp",
  tool: "web_search",
  retrievedAt: "2026-10-31T00:00:00.000Z",
  maxResults: 10,
};

describe("evidence normalization", () => {
  test("normalizes common result shapes and preserves provenance", () => {
    const sources = normalizeWebResults(
      {
        results: [
          {
            title: "Trees and heat",
            link: "https://example.test/trees",
            description: "Urban trees cool streets.",
            date: "2026-07-01",
          },
        ],
      },
      context,
    );
    expect(sources).toEqual([
      {
        sourceId: stableSourceId("https://example.test/trees"),
        url: "https://example.test/trees",
        title: "Trees and heat",
        snippet: "Urban trees cool streets.",
        publishedAt: "2026-07-01",
        trust: "untrusted",
        provenance: {
          provider: "mcp",
          tool: "web_search",
          retrievedAt: "2026-10-31T00:00:00.000Z",
        },
      },
    ]);
  });

  test("drops invalid URLs, deduplicates, and caps results", () => {
    const sources = normalizeWebResults(
      [
        { url: "https://example.test/a", title: "A" },
        { url: "https://example.test/a", title: "Duplicate" },
        { url: "javascript:alert(1)", title: "Bad" },
        { url: "https://example.test/b", title: "B" },
      ],
      { ...context, maxResults: 2 },
    );
    expect(sources.map(({ url }) => url)).toEqual([
      "https://example.test/a",
      "https://example.test/b",
    ]);
  });

  test("accepts grouped provider shapes such as { data: { web: [...] } }", () => {
    const sources = normalizeWebResults(
      {
        success: true,
        data: {
          web: [
            {
              url: "https://example.test/grouped",
              title: "Grouped",
              description: "Snippet.",
            },
          ],
        },
      },
      context,
    );
    expect(sources).toHaveLength(1);
    expect(sources[0].url).toBe("https://example.test/grouped");
  });

  test("rejects unsupported or empty result shapes", () => {
    for (const value of [{ nope: true }, []]) {
      try {
        normalizeWebResults(value, context);
        throw new Error("Expected an invalid result shape.");
      } catch (error) {
        expect(error).toBeInstanceOf(IntegrationError);
        expect(error.code).toBe("WEB_SEARCH_INVALID_RESULT");
      }
    }
  });
});
