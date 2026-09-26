import { expect, test } from "bun:test";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { createMinioProvider } from "../dist/index.js";

test("MinIO provider writes bytes with content type and returns a reversible URI", async () => {
  const sent = [];
  const client = { send: async (command) => {
    sent.push(command);
    if (command instanceof GetObjectCommand) return { Body: { transformToByteArray: async () => new Uint8Array([0, 1, 255]) } };
    return {};
  } };
  const provider = createMinioProvider({ client, bucket: "unknownplanet-artifacts" });
  const data = new Uint8Array([0, 1, 255]);
  const { uri } = await provider.blobs.put({ key: "tenant one/reports/a#b.pdf", data, contentType: "application/pdf" });

  expect(uri).toBe("s3://unknownplanet-artifacts/tenant%20one/reports/a%23b.pdf");
  expect(sent[0]).toBeInstanceOf(PutObjectCommand);
  expect(sent[0].input).toMatchObject({ Bucket: "unknownplanet-artifacts", Key: "tenant one/reports/a#b.pdf", Body: data, ContentType: "application/pdf" });
  expect(await provider.blobs.get(uri)).toEqual(data);
  expect(sent[1]).toBeInstanceOf(GetObjectCommand);
  expect(sent[1].input).toEqual({ Bucket: "unknownplanet-artifacts", Key: "tenant one/reports/a#b.pdf" });
  await provider.blobs.delete(uri);
  expect(sent[2]).toBeInstanceOf(DeleteObjectCommand);
  expect(sent[2].input).toEqual({ Bucket: "unknownplanet-artifacts", Key: "tenant one/reports/a#b.pdf" });
});

test("MinIO provider validates configuration, object keys, and blob URIs", async () => {
  const provider = createMinioProvider({ client: { send: async () => ({}) }, bucket: "artifacts" });
  expect(() => createMinioProvider({ client: { send: async () => ({}) }, bucket: " " })).toThrow("bucket must be non-empty");
  await expect(provider.blobs.put({ key: "", data: new Uint8Array() })).rejects.toThrow("Blob key must be non-empty");
  await expect(provider.blobs.get("s3://other/key")).rejects.toThrow("configured MinIO bucket");
  await expect(provider.blobs.delete("s3://artifacts/")).rejects.toThrow("include an object key");
  await expect(provider.blobs.get("s3://artifacts/%E0%A4%A")).rejects.toThrow("invalid encoded object key");
  await expect(provider.blobs.get("s3://artifacts/missing")).rejects.toThrow("no response body");
});

test("MinIO URI encoding preserves dot-segment keys", async () => {
  const client = { send: async (command) => command instanceof GetObjectCommand ? { Body: { transformToByteArray: async () => new Uint8Array() } } : {} };
  const provider = createMinioProvider({ client, bucket: "artifacts" });
  const { uri } = await provider.blobs.put({ key: "../file.txt", data: new Uint8Array() });
  expect(uri).toBe("s3://artifacts/%2E%2E/file.txt");
  await provider.blobs.get(uri);
});

test("MinIO schemas map prefixes blob objects and preserves reversible URIs", async () => {
  const sent = [];
  const provider = createMinioProvider({ client: { send: async (command) => { sent.push(command); return {}; } }, bucket: "artifacts", schemas: { blobs: "tenant-data/v2" } });
  const { uri } = await provider.blobs.put({ key: "report.json", data: new Uint8Array([1]) });
  expect(sent[0].input.Key).toBe("tenant-data/v2/report.json");
  expect(uri).toBe("s3://artifacts/tenant-data/v2/report.json");
  expect(() => createMinioProvider({ client: { send: async () => ({}) }, bucket: "artifacts", schemas: { blobs: "../unsafe" } })).toThrow("cannot contain");
});
