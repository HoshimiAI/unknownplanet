import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import type { BlobStorageAdapter, DataLayerProvider } from "@unknown-planet/core";

const encodeKey = (key: string): string => key.split("/").map((part) => {
  const encoded = encodeURIComponent(part);
  return part === "." || part === ".." ? encoded.replaceAll(".", "%2E") : encoded;
}).join("/");

function keyFromUri(uri: string, bucket: string): string {
  const prefix = `s3://${bucket}/`;
  if (!uri.startsWith(prefix)) throw new Error(`Blob URI must reference the configured MinIO bucket '${bucket}'.`);
  const encodedKey = uri.slice(prefix.length);
  if (!encodedKey) throw new Error("Blob URI must include an object key.");
  try {
    return encodedKey.split("/").map(decodeURIComponent).join("/");
  } catch {
    throw new Error("Blob URI contains an invalid encoded object key.");
  }
}

export class MinioBlobStorage implements BlobStorageAdapter {
  constructor(private readonly client: S3Client, private readonly bucket: string, private readonly prefix = "") {
    if (!bucket.trim()) throw new Error("MinIO bucket must be non-empty.");
  }

  async put(input: { key: string; data: Uint8Array; contentType?: string; metadata?: import("@unknown-planet/core").JsonObject }): Promise<{ uri: string }> {
    if (!input.key) throw new Error("Blob key must be non-empty.");
    const key = this.prefix ? `${this.prefix}/${input.key}` : input.key;
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: input.data, ContentType: input.contentType, Metadata: input.metadata ? { "unknownplanet-custom-data": JSON.stringify(input.metadata) } : undefined }));
    return { uri: `s3://${this.bucket}/${encodeKey(key)}` };
  }

  async get(uri: string): Promise<Uint8Array> {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: keyFromUri(uri, this.bucket) }));
    if (!result.Body) throw new Error(`Blob object '${uri}' has no response body.`);
    return result.Body.transformToByteArray();
  }

  async getMetadata(uri: string): Promise<import("@unknown-planet/core").JsonObject> {
    const result = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: keyFromUri(uri, this.bucket) }));
    const encoded = result.Metadata?.["unknownplanet-custom-data"];
    if (!encoded) return {};
    const value: unknown = JSON.parse(encoded);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Blob object '${uri}' has invalid custom metadata.`);
    return value as import("@unknown-planet/core").JsonObject;
  }

  async delete(uri: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: keyFromUri(uri, this.bucket) }));
  }
}

export function createMinioProvider(input: { id?: string; client: S3Client; bucket: string; schemas?: import("@unknown-planet/core").ProviderSchemaMap }): DataLayerProvider {
  const prefix = input.schemas?.blobs?.replace(/^\/+|\/+$/g, "") ?? "";
  if (prefix.split("/").some((part) => part === "." || part === "..")) throw new Error("MinIO blob namespace cannot contain '.' or '..' path segments.");
  return { id: input.id ?? "minio", blobs: new MinioBlobStorage(input.client, input.bucket, prefix) };
}
