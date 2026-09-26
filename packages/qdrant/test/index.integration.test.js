import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createQdrantProvider, initializeQdrantCollections } from "../dist/index.js";

const url = process.env.UP_TEST_QDRANT_URL;
if (url) test("Qdrant stores and retrieves scoped vectors in a live collection", async () => {
  const { QdrantClient } = await import("@qdrant/js-client-rest");
  const client = new QdrantClient({ url, apiKey: process.env.UP_TEST_QDRANT_API_KEY, checkCompatibility: false });
  const collection = `up_test_${randomUUID().replaceAll("-", "")}`;
  const collections = { memory: { collection, dimensions: 3, model: "integration-test" } };
  const scope = { tenantId: `integration-${randomUUID()}` };
  try {
    await initializeQdrantCollections(client, collections);
    const provider = createQdrantProvider({ client, collections });
    await provider.vector.upsert({ id: "memory-1", namespace: "memory", model: "integration-test", embedding: [1, 0, 0], metadata: { live: true }, scope });
    expect(await provider.vector.search({ namespace: "memory", embedding: [1, 0, 0], model: "integration-test", scope })).toMatchObject([{ id: "memory-1", namespace: "memory", metadata: { live: true } }]);
    await provider.vector.delete({ id: "memory-1", namespace: "memory", scope });
    expect(await provider.vector.search({ namespace: "memory", embedding: [1, 0, 0], model: "integration-test", scope })).toEqual([]);
  } finally {
    await client.deleteCollection(collection).catch(() => undefined);
  }
});
