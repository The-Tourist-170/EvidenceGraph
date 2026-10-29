import { describe, expect, test } from "bun:test";
import { createObjectStorage } from "./index.js";

const config = {
  endpoint: "http://localhost:9000",
  accessKeyId: "test-access-key",
  secretAccessKey: "test-secret-key",
  bucket: "evidencegraph-test-files",
};

function createMockClient({ bucketExists = false, headFailures = 0 } = {}) {
  const commands = [];
  let hasBucket = bucketExists;
  let failuresRemaining = headFailures;
  return {
    commands,
    destroy() {},
    async send(command) {
      commands.push(command);
      if (
        command.constructor.name === "HeadBucketCommand" &&
        failuresRemaining > 0
      ) {
        failuresRemaining -= 1;
        throw new Error("transient storage failure");
      }
      if (command.constructor.name === "HeadBucketCommand" && !hasBucket) {
        const error = new Error("bucket not found");
        error.$metadata = { httpStatusCode: 404 };
        throw error;
      }
      if (command.constructor.name === "CreateBucketCommand") {
        hasBucket = true;
      }
      if (command.constructor.name === "GetObjectCommand") {
        return {
          Body: {
            async transformToByteArray() {
              return new Uint8Array([97, 98, 99]);
            },
          },
          ContentType: "text/plain",
        };
      }
      return {};
    },
  };
}

describe("MinIO object storage", () => {
  test("creates a missing bucket once and performs an object round-trip", async () => {
    const client = createMockClient();
    const storage = createObjectStorage({ config, client });

    await storage.initialize();
    await storage.initialize();
    await storage.putObject({
      key: "documents/00000000-0000-4000-8000-000000000001",
      bytes: new Uint8Array([97, 98, 99]),
      mediaType: "text/plain",
    });
    const object = await storage.getObject(
      "documents/00000000-0000-4000-8000-000000000001",
    );
    await storage.deleteObject(
      "documents/00000000-0000-4000-8000-000000000001",
    );

    expect(client.commands.map((command) => command.constructor.name)).toEqual([
      "HeadBucketCommand",
      "CreateBucketCommand",
      "PutObjectCommand",
      "GetObjectCommand",
      "DeleteObjectCommand",
    ]);
    expect(object).toEqual({
      bytes: new Uint8Array([97, 98, 99]),
      mediaType: "text/plain",
    });
    expect(await storage.checkHealth()).toBe(true);
  });

  test("retries initialization after a transient bucket-check failure", async () => {
    const client = createMockClient({ headFailures: 1 });
    const storage = createObjectStorage({ config, client });

    await expect(storage.initialize()).rejects.toThrow(
      "transient storage failure",
    );
    await storage.initialize();

    expect(client.commands.map((command) => command.constructor.name)).toEqual([
      "HeadBucketCommand",
      "HeadBucketCommand",
      "CreateBucketCommand",
    ]);
  });

  test("does not create a bucket when it already exists", async () => {
    const client = createMockClient({ bucketExists: true });
    const storage = createObjectStorage({ config, client });

    await storage.initialize();

    expect(client.commands.map((command) => command.constructor.name)).toEqual([
      "HeadBucketCommand",
    ]);
  });
});
