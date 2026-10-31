import { createHash } from "node:crypto";
import { z } from "zod";
import { IntegrationError } from "./errors.js";
import { parseSafeUrl, sanitizeUntrustedText } from "./guardrails.js";

export const evidenceSourceSchema = z
  .object({
    sourceId: z.string().min(1).max(128),
    url: z.string().url(),
    title: z.string().max(512),
    snippet: z.string().max(4_000),
    publishedAt: z.string().max(64).optional(),
    trust: z.literal("untrusted"),
    provenance: z
      .object({
        provider: z.string().min(1).max(80),
        tool: z.string().min(1).max(120),
        retrievedAt: z.string().min(1).max(64),
      })
      .strict(),
  })
  .strict();

export const evidenceSourcesSchema = z.array(evidenceSourceSchema).max(50);

export function stableSourceId(url) {
  return createHash("sha256").update(url).digest("hex").slice(0, 32);
}

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.length > 0);
}

function normalizeResult(item, context) {
  if (!item || typeof item !== "object") return null;
  const rawUrl = firstString(item.url, item.link, item.href);
  if (!rawUrl) return null;
  let url;
  try {
    url = parseSafeUrl(rawUrl);
  } catch {
    return null;
  }
  const title = sanitizeUntrustedText(
    firstString(item.title, item.name, item.headline) ?? url,
    { maxLength: 512 },
  );
  const snippet = sanitizeUntrustedText(
    firstString(item.snippet, item.description, item.content, item.text) ?? "",
    { maxLength: 4_000 },
  );
  const publishedAt = firstString(
    item.publishedAt,
    item.published_at,
    item.date,
    item.published,
  );
  return evidenceSourceSchema.parse({
    sourceId: stableSourceId(url),
    url,
    title: title || url,
    snippet,
    ...(publishedAt ? { publishedAt: publishedAt.slice(0, 64) } : {}),
    trust: "untrusted",
    provenance: context,
  });
}

export function normalizeWebResults(
  raw,
  { provider, tool, retrievedAt, maxResults = 10 },
) {
  const results = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.results)
      ? raw.results
      : Array.isArray(raw?.data)
        ? raw.data
        : null;
  if (!results) {
    throw new IntegrationError(
      "WEB_SEARCH_INVALID_RESULT",
      "The web-search tool returned an unsupported result shape.",
    );
  }
  const context = { provider, tool, retrievedAt };
  const seen = new Set();
  const normalized = [];
  for (const item of results) {
    const source = normalizeResult(item, context);
    if (!source || seen.has(source.url)) continue;
    seen.add(source.url);
    normalized.push(source);
    if (normalized.length >= maxResults) break;
  }
  if (normalized.length === 0) {
    throw new IntegrationError(
      "WEB_SEARCH_INVALID_RESULT",
      "The web-search tool returned no usable sources.",
    );
  }
  return evidenceSourcesSchema.parse(normalized);
}
