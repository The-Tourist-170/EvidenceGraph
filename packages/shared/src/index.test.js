import { describe, expect, test } from "bun:test";
import { AppError } from "./index.js";

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
