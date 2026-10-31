import { IntegrationError } from "./errors.js";

function stripControlCharacters(value) {
  let result = "";
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code === 9 || code === 10 || code === 13) {
      result += character;
      continue;
    }
    if (code < 32 || code === 127) continue;
    result += character;
  }
  return result;
}
const labelCharacters = /[^a-zA-Z0-9._-]/g;
const blockedKeys = new Set(["__proto__", "constructor", "prototype"]);

export function sanitizeUntrustedText(value, { maxLength = 12_000 } = {}) {
  if (typeof value !== "string") return "";
  return stripControlCharacters(value.normalize("NFKC").replace(/\r\n?/g, "\n"))
    .slice(0, maxLength)
    .trim();
}

export function sanitizeLabel(value) {
  return String(value ?? "data")
    .replace(labelCharacters, "-")
    .slice(0, 80);
}

/**
 * Retrieved content is data, never instructions. Wrapping it in explicit
 * delimiters keeps it separate from the system prompt.
 */
export function asUntrustedData(label, value, options) {
  return [
    `<untrusted-data source="${sanitizeLabel(label)}">`,
    sanitizeUntrustedText(value, options),
    "</untrusted-data>",
  ].join("\n");
}

export function parseSafeUrl(value, { maxLength = 2_048 } = {}) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength
  ) {
    throw new IntegrationError(
      "UNTRUSTED_URL_REJECTED",
      "A retrieved source URL was rejected.",
    );
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new IntegrationError(
      "UNTRUSTED_URL_REJECTED",
      "A retrieved source URL was rejected.",
    );
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new IntegrationError(
      "UNTRUSTED_URL_REJECTED",
      "A retrieved source URL was rejected.",
    );
  }
  if (url.username || url.password) {
    throw new IntegrationError(
      "UNTRUSTED_URL_REJECTED",
      "A retrieved source URL was rejected.",
    );
  }
  return url.toString();
}

export function assertSafeToolArguments(
  value,
  { maxDepth = 6, maxBytes = 32_000, depth = 0 } = {},
) {
  if (depth > maxDepth) {
    throw new IntegrationError(
      "TOOL_ARGUMENTS_REJECTED",
      "Tool arguments exceeded the allowed nesting depth.",
    );
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      assertSafeToolArguments(item, { maxDepth, maxBytes, depth: depth + 1 });
    }
    return value;
  }
  for (const [key, item] of Object.entries(value)) {
    if (blockedKeys.has(key)) {
      throw new IntegrationError(
        "TOOL_ARGUMENTS_REJECTED",
        "Tool arguments contained a reserved key.",
      );
    }
    assertSafeToolArguments(item, { maxDepth, maxBytes, depth: depth + 1 });
  }
  if (depth === 0) {
    const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
    if (bytes > maxBytes) {
      throw new IntegrationError(
        "TOOL_ARGUMENTS_REJECTED",
        "Tool arguments exceeded the allowed size.",
      );
    }
  }
  return value;
}

export function redactSecrets(value, secrets = []) {
  let text = typeof value === "string" ? value : String(value ?? "");
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 4) {
      text = text.split(secret).join("[redacted]");
    }
  }
  return text;
}
