import { describe, expect, test } from "bun:test";
import { handleRequest } from "./index.js";

describe("health endpoint", () => {
  test("returns an ok status", async () => {
    const request = new Request("http://localhost/health");
    const response = handleRequest(request);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  test("returns not found for unknown routes", async () => {
    const request = new Request("http://localhost/unknown");
    const response = handleRequest(request);

    expect(response.status).toBe(404);
  });
});
