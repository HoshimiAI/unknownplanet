import { expect, test } from "bun:test";
import { createQdrantProvider, initializeQdrantCollections } from "../dist/index.js";

const collections = {
  memory: { collection: "planet_vectors", dimensions: 3, model: "embed-v1" },
  node: { collection: "planet_vectors", dimensions: 3, model: "embed-v1" },
};

test("Qdrant creates configured collections once and preserves existing collections", async () => {
  const created = [];
  let existing = [];
  const client = {
    getCollections: async () => ({ collections: existing.map((name) => ({ name })) }),
    createCollection: async (name, config) => { created.push({ name, config }); },
  };
  await initializeQdrantCollections(client, collections);
  expect(created).toEqual([{ name: "planet_vectors", config: { vectors: { size: 3, distance: "Cosine" } } }]);
  existing = ["planet_vectors"];
  await initializeQdrantCollections(client, collections);
  expect(created).toHaveLength(1);
  await expect(initializeQdrantCollections(client, { one: collections.memory, two: { ...collections.node, dimensions: 4 } })).rejects.toThrow("different dimensions");
});

test("Qdrant scopes deterministic vector IDs, filters search, and deletes by mapped ID", async () => {
  const upserts = [];
  const queries = [];
  const deletes = [];
  const client = {
    getCollections: async () => ({ collections: [] }),
    createCollection: async () => {},
    upsert: async (collection, input) => { upserts.push({ collection, input }); },
    query: async (collection, input) => { queries.push({ collection, input }); return { points: [{ id: "opaque-id", score: 0.92, payload: { _up_id: "memory-1", _up_namespace: "memory", metadata: { agentId: "agent-1" } } }] }; },
    delete: async (collection, input) => { deletes.push({ collection, input }); },
  };
  const provider = createQdrantProvider({ client, collections });
  const scope = { tenantId: "acme", workspaceId: "research" };
  await provider.vector.upsert({ id: "memory-1", namespace: "memory", embedding: [0.1, 0.2, 0.3], metadata: { agentId: "agent-1" }, scope });
  await provider.vector.upsert({ id: "memory-1", namespace: "memory", embedding: [0.1, 0.2, 0.3], metadata: { agentId: "agent-1" }, scope });
  expect(upserts[0].collection).toBe("planet_vectors");
  expect(upserts[0].input.points[0].id).toBe(upserts[1].input.points[0].id);
  expect(upserts[0].input.points[0].payload._up_scope).toBe('["acme","research"]');
  const results = await provider.vector.search({ namespace: "memory", embedding: [0.1, 0.2, 0.3], metadata: { agentId: "agent-1" }, limit: 5, scope });
  expect(results).toEqual([{ id: "memory-1", namespace: "memory", score: 0.92, metadata: { agentId: "agent-1" } }]);
  expect(queries[0].input.filter.must).toContainEqual({ key: "_up_scope", match: { value: '["acme","research"]' } });
  expect(queries[0].input.filter.must).toContainEqual({ key: "metadata.agentId", match: { value: "agent-1" } });
  expect(queries[0].input.limit).toBe(5);
  await provider.vector.delete({ id: "memory-1", namespace: "memory", scope });
  expect(deletes[0].input.points[0]).toBe(upserts[0].input.points[0].id);
});

test("Qdrant rejects bad dimensions and unconfigured namespaces", async () => {
  const client = { upsert: async () => {}, query: async () => ({ points: [] }), delete: async () => {} };
  const provider = createQdrantProvider({ client, collections });
  await expect(provider.vector.upsert({ id: "id", namespace: "missing", embedding: [1] })).rejects.toThrow("No Qdrant collection");
  await expect(provider.vector.search({ namespace: "memory", embedding: [1] })).rejects.toThrow("requires 3 finite dimensions");
});

test("Qdrant schemas map prefixes configured collection names", async () => {
  const calls = [];
  const client = { upsert: async (name) => { calls.push(name); }, getCollections: async () => ({ collections: [] }), createCollection: async (name) => { calls.push(`create:${name}`); } };
  const provider = createQdrantProvider({ client, collections, schemas: { vector: "tenant_v2" } });
  await provider.vector.upsert({ id: "id", namespace: "memory", embedding: [1, 2, 3] });
  expect(calls).toEqual(["tenant_v2_planet_vectors"]);
  await initializeQdrantCollections(client, collections, { vector: "tenant_v2" });
  expect(calls.at(-1)).toBe("create:tenant_v2_planet_vectors");
  expect(() => createQdrantProvider({ client: {}, collections, schemas: { vector: "bad namespace" } })).toThrow("only letters");
});
