import { z } from "zod";
import { normalizeWebResults } from "./evidence.js";
import { classifyProviderError, IntegrationError } from "./errors.js";
import {
  assertSafeToolArguments,
  sanitizeUntrustedText,
} from "./guardrails.js";

const skillKindSchema = z.enum(["web-search", "source-retrieval"]);

const skillDefinitionSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).default(""),
  kind: skillKindSchema,
  inputSchema: z.any(),
  execute: z.function(),
  maxResults: z.number().int().min(1).max(50).default(10),
  timeoutMs: z.number().int().min(1_000).max(120_000).default(15_000),
});

export function createSkillsToolAdapter({
  skills = [],
  metrics,
  now = () => new Date(),
} = {}) {
  const registry = new Map();
  for (const skill of skills) {
    const parsed = skillDefinitionSchema.parse(skill);
    if (registry.has(parsed.name)) {
      throw new IntegrationError(
        "SKILL_DUPLICATE",
        "A skill with this name is already registered.",
      );
    }
    registry.set(parsed.name, parsed);
  }

  function list() {
    return [...registry.values()].map(({ name, description, kind }) => ({
      name,
      description,
      kind,
    }));
  }

  async function invoke(name, args, { signal, retrievedAt } = {}) {
    const skill = registry.get(name);
    if (!skill) {
      throw new IntegrationError(
        "SKILL_NOT_FOUND",
        "The requested skill is not registered.",
      );
    }
    let parsedArgs;
    try {
      parsedArgs = skill.inputSchema.parse(args);
      assertSafeToolArguments(parsedArgs);
    } catch (error) {
      throw new IntegrationError(
        "SKILL_ARGUMENTS_INVALID",
        "The skill request arguments were invalid.",
        { cause: error },
      );
    }
    const timeoutSignal = AbortSignal.timeout(skill.timeoutMs);
    const combined = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;
    const started = performance.now();
    try {
      const raw = await skill.execute(parsedArgs, { signal: combined });
      const sources = normalizeWebResults(raw, {
        provider: "skills",
        tool: sanitizeUntrustedText(name, { maxLength: 80 }),
        retrievedAt: (retrievedAt ?? now()).toISOString(),
        maxResults: skill.maxResults,
      });
      metrics?.recordCall({
        operation: "skill_invoke",
        durationMs: performance.now() - started,
        ok: true,
      });
      return sources;
    } catch (error) {
      const classified =
        error instanceof IntegrationError
          ? error
          : classifyProviderError(error, { operation: `Skill ${name}` });
      metrics?.recordCall({
        operation: "skill_invoke",
        durationMs: performance.now() - started,
        ok: false,
        code: classified.code,
      });
      throw classified;
    }
  }

  return {
    available: registry.size > 0,
    has: (name) => registry.has(name),
    invoke,
    list,
  };
}
