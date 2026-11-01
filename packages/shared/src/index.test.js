import { afterEach, describe, expect, test } from "bun:test";
import { AppError, logger } from "./index.js";

const originalForceColor = process.env.FORCE_COLOR;
const originalNoColor = process.env.NO_COLOR;
const originalLog = console.log;

afterEach(() => {
  if (originalForceColor === undefined) delete process.env.FORCE_COLOR;
  else process.env.FORCE_COLOR = originalForceColor;
  if (originalNoColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = originalNoColor;
  console.log = originalLog;
});

describe("terminal logger", () => {
  test("formats a readable date and time and colors scoped log lines", () => {
    let output = "";
    console.log = (line) => {
      output = line;
    };
    process.env.FORCE_COLOR = "1";
    delete process.env.NO_COLOR;

    logger.info("Worker job progress", {
      queue: "document-ingestion",
      worker: "document-ingestion-worker",
      stage: "text-extraction",
      percent: 65,
    });

    const plain = [
      "\u001b[2m",
      "\u001b[31m",
      "\u001b[32m",
      "\u001b[33m",
      "\u001b[35m",
      "\u001b[36m",
      "\u001b[0m",
    ].reduce((value, sequence) => value.split(sequence).join(""), output);
    expect(plain).toMatch(
      /^\d{2}\/\d{2}\/\d{2} \| \d{2}:\d{2}\s{2}INFO\s+\[document-ingestion-worker\]/,
    );
    expect(plain).toContain("Worker job progress");
    expect(plain).toContain('stage="text-extraction"');
    expect(plain).toContain("percent=65");
    expect(output).toContain("\u001b[36m");
    expect(output).toContain("\u001b[0m");
  });
});

describe("AppError", () => {
  test("preserves a stable error code and cause", () => {
    const cause = new Error("root cause");
    const error = new AppError("Operation failed", {
      code: "OPERATION_FAILED",
      cause,
    });

    expect(error.message).toBe("Operation failed");
    expect(error.code).toBe("OPERATION_FAILED");
    expect(error.cause).toBe(cause);
  });
});
