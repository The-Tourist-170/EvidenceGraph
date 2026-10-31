import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { IntegrationError } from "./errors.js";
import { createSkillsToolAdapter } from "./skills.js";

const skill = {
  name: "fixture-search",
  description: "Fixture search skill.",
  kind: "web-search",
  inputSchema: z.object({ query: z.string().min(1), limit: z.number().int() }),
  execute: async ({ query, limit }) => ({
    results: [
      {
        title: `Skill result for ${query}`,
        url: "https://skills.example.test/1",
        snippet: "Skill snippet.",
      },
    ].slice(0, limit),
  }),
};

describe("skills tool adapter", () => {
  test("lists and invokes validated skills with provenance", async () => {
    const adapter = createSkillsToolAdapter({ skills: [skill] });
    expect(adapter.available).toBe(true);
    expect(adapter.list()).toEqual([
      {
        name: "fixture-search",
        description: "Fixture search skill.",
        kind: "web-search",
      },
    ]);
    const sources = await adapter.invoke("fixture-search", {
      query: "trees",
      limit: 1,
    });
    expect(sources[0]).toMatchObject({
      url: "https://skills.example.test/1",
      trust: "untrusted",
      provenance: { provider: "skills", tool: "fixture-search" },
    });
  });

  test("rejects unknown skills and invalid arguments", async () => {
    const adapter = createSkillsToolAdapter({ skills: [skill] });
    await expect(adapter.invoke("missing", {})).rejects.toMatchObject({
      code: "SKILL_NOT_FOUND",
    });
    await expect(
      adapter.invoke("fixture-search", { query: "", limit: 1 }),
    ).rejects.toMatchObject({ code: "SKILL_ARGUMENTS_INVALID" });
  });

  test("rejects duplicate skill registrations", () => {
    try {
      createSkillsToolAdapter({ skills: [skill, skill] });
      throw new Error("Expected duplicate registration to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(IntegrationError);
      expect(error.code).toBe("SKILL_DUPLICATE");
    }
  });

  test("normalizes provider failures", async () => {
    const adapter = createSkillsToolAdapter({
      skills: [
        {
          ...skill,
          execute: async () => {
            throw new Error("raw skill failure");
          },
        },
      ],
    });
    await expect(
      adapter.invoke("fixture-search", { query: "trees", limit: 1 }),
    ).rejects.toMatchObject({ code: "PROVIDER_REQUEST_FAILED" });
  });
});
