/**
 * @extends {Error}
 */
export class AppError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, cause?: unknown }} [options]
   */
  constructor(message, { code = "INTERNAL_ERROR", cause } = {}) {
    super(message, { cause });
    this.name = "AppError";
    this.code = code;
  }
}

const ansi = {
  reset: "\u001b[0m",
  dim: "\u001b[2m",
  cyan: "\u001b[36m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  red: "\u001b[31m",
  magenta: "\u001b[35m",
};

const scopeColors = [ansi.cyan, ansi.magenta, ansi.green, ansi.yellow];

function timestamp(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${String(date.getFullYear()).slice(-2)} | ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatValue(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null || typeof value !== "object") return String(value);
  return JSON.stringify(value);
}

function log(level, message, fields = {}) {
  const date = new Date();
  const stamp = timestamp(date);
  const colorEnabled =
    !process.env.NO_COLOR &&
    process.env.FORCE_COLOR !== "0" &&
    (process.stdout?.isTTY || Number(process.env.FORCE_COLOR) > 0);
  const levelStyle = {
    info: ansi.cyan,
    success: ansi.green,
    warn: ansi.yellow,
    error: ansi.red,
  }[level];
  const scope = fields.worker ?? fields.queue ?? fields.component;
  const scopeColor = scope
    ? scopeColors[
        [...String(scope)].reduce(
          (sum, character) => sum + character.charCodeAt(0),
          0,
        ) % scopeColors.length
      ]
    : "";
  const details = Object.entries(fields).filter(
    ([, value]) => value !== undefined,
  );
  const rest = details
    .map(([key, value]) => `${key}=${formatValue(value)}`)
    .join("  ");
  const plain = `${stamp}  ${level.toUpperCase().padEnd(7)}${scope ? ` [${scope}]` : ""}  ${message}${rest ? `  ${rest}` : ""}`;
  const line = colorEnabled
    ? `${ansi.dim}${stamp}${ansi.reset}  ${levelStyle}${level.toUpperCase().padEnd(7)}${ansi.reset}${scope ? ` ${scopeColor}[${scope}]${ansi.reset}` : ""}  ${message}${rest ? `  ${ansi.dim}${rest}${ansi.reset}` : ""}`
    : plain;
  const output = level === "error" ? console.error : console.log;
  output(line);
}

export const logger = {
  info(message, fields = {}) {
    log("info", message, fields);
  },
  success(message, fields = {}) {
    log("success", message, fields);
  },
  warn(message, fields = {}) {
    log("warn", message, fields);
  },
  error(message, fields = {}) {
    log("error", message, fields);
  },
};
