import { expect, test } from "bun:test";
import { S3Client } from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import { createMinioProvider } from "../dist/index.js";

const endpoint = process.env.UP_TEST_MINIO_ENDPOINT;
if (endpoint) test("MinIO persists and retrieves binary blobs from the configured bucket", async () => {
  const client = new S3Client({
    endpoint,
    region: process.env.UP_TEST_MINIO_REGION ?? "us-east-1",
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.UP_TEST_MINIO_ACCESS_KEY ?? "unknownplanet",
      secretAccessKey: process.env.UP_TEST_MINIO_SECRET_KEY ?? "unknownplanet",
    },
  });
  const provider = createMinioProvider({ client, bucket: process.env.UP_TEST_MINIO_BUCKET ?? "unknownplanet-artifacts" });
  const key = `provider-tests/${randomUUID()}/sample.bin`;
  const data = new Uint8Array([0, 1, 127, 128, 255]);
  try {
    const { uri } = await provider.blobs.put({ key, data, contentType: "application/octet-stream" });
    expect(uri).toBe(`s3://${process.env.UP_TEST_MINIO_BUCKET ?? "unknownplanet-artifacts"}/${key}`);
    expect(await provider.blobs.get(uri)).toEqual(data);
  } finally {
    await provider.blobs.delete(`s3://${process.env.UP_TEST_MINIO_BUCKET ?? "unknownplanet-artifacts"}/${key}`);
    client.destroy();
  }
});
