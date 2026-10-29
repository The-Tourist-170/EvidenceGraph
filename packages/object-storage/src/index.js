import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getMinioConfig } from "@evidencegraph/config";

export function createObjectStorage({
  config = getMinioConfig(),
  client,
} = {}) {
  const s3 =
    client ??
    new S3Client({
      endpoint: config.endpoint,
      forcePathStyle: true,
      region: "us-east-1",
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  let bucketInitialization;

  async function initialize() {
    if (!bucketInitialization) {
      const pendingInitialization = (async () => {
        try {
          await s3.send(new HeadBucketCommand({ Bucket: config.bucket }));
        } catch (error) {
          if (
            error?.$metadata?.httpStatusCode !== 404 &&
            error?.name !== "NoSuchBucket" &&
            error?.name !== "NotFound"
          ) {
            throw error;
          }
          try {
            await s3.send(new CreateBucketCommand({ Bucket: config.bucket }));
          } catch (createError) {
            if (createError?.name !== "BucketAlreadyOwnedByYou")
              throw createError;
          }
        }
      })();
      bucketInitialization = pendingInitialization.catch((error) => {
        bucketInitialization = undefined;
        throw error;
      });
    }
    return bucketInitialization;
  }

  async function putObject({ key, bytes, mediaType }) {
    await initialize();
    await s3.send(
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: bytes,
        ContentType: mediaType,
      }),
    );
  }

  async function getObject(key) {
    await initialize();
    const result = await s3.send(
      new GetObjectCommand({ Bucket: config.bucket, Key: key }),
    );
    if (!result.Body) throw new Error("Object storage returned an empty body.");
    return {
      bytes: new Uint8Array(await result.Body.transformToByteArray()),
      mediaType: result.ContentType ?? "application/octet-stream",
    };
  }

  async function deleteObject(key) {
    await initialize();
    await s3.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
  }

  async function checkHealth() {
    await initialize();
    await s3.send(new HeadBucketCommand({ Bucket: config.bucket }));
    return true;
  }

  function close() {
    s3.destroy();
  }

  return { checkHealth, close, deleteObject, getObject, initialize, putObject };
}
