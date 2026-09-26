import { expect, test } from "bun:test";
import { MongoAtlasVectorStore, MongoGraphStore, MongoKeyValueStore, MongoMemoryStore, MongoQueueStore, MongoStackStore, createMongoProvider, initializeMongoIndexes } from "../dist/index.js";

test("Mongo provider schemas map prefixes to each feature collection", () => {
  const names = [];
  const collection = () => ({});
  const provider = createMongoProvider({ database: { collection(name) { names.push(name); return collection(); } }, schemas: { graph: "tenant_graph", documents: "tenant_docs", vector: "tenant_vec", keyValue: "tenant_kv" } });
  expect(provider.graph).toBeDefined();
  expect(names).toContain("tenant_graph_nodes");
  expect(names).toContain("tenant_graph_edges");
  expect(names).toContain("tenant_docs_documents");
  expect(names).toContain("tenant_vec_vectors");
  expect(names).toContain("tenant_kv_key_values");
  expect(() => createMongoProvider({ database: { collection }, schemas: { memories: "bad namespace" } })).toThrow("only letters");
});

test("Mongo index initialization uses the same mapped collections", async () => {
  const names = [];
  await initializeMongoIndexes({ collection(name) { names.push(name); return { createIndex: async () => {} }; } }, { graph: "g", vector: "v", documents: "d" });
  expect(names).toContain("g_nodes");
  expect(names).toContain("g_edges");
  expect(names).toContain("v_vectors");
  expect(names).toContain("d_documents");
});

test("Mongo graph reads always constrain edges and nodes to the requested scope", async () => {
  const calls = [];
  const emptyCursor = { sort() { return this; }, limit() { return this; }, async toArray() { return []; } };
  const db = { collection(name) { return { find(filter) { calls.push([name, filter]); return emptyCursor; } }; } };
  const graph = new MongoGraphStore(db);
  const scope = { tenantId: "acme", workspaceId: "research" };
  await graph.neighbors({ nodeId: "node-1", scope });
  await graph.traverse({ startIds: ["node-1"], depth: 1, scope });
  await graph.searchNodes({ query: "attention", scope });
  const serialized = JSON.stringify(calls);
  expect(serialized).toContain('"scopeId":"acme:research"');
  expect(calls.filter(([name]) => name === "edges").length).toBeGreaterThan(0);
  expect(calls.filter(([name]) => name === "nodes").length).toBeGreaterThan(0);
});

test("Mongo memory pagination treats query text literally", async () => {
  let receivedFilter;
  const db = { collection: () => ({
    find(filter) { receivedFilter = filter; return { sort() { return this; }, limit() { return this; }, async toArray() { return []; } }; },
  }) };
  const store = new MongoMemoryStore(db);
  await store.searchPage({ query: "a.b*[x]\\y", afterId: "memory-1", limit: 10, scope: { tenantId: "acme" } });

  expect(receivedFilter.content).toEqual({ $regex: "a\\.b\\*\\[x\\]\\\\y", $options: "i" });
  expect(receivedFilter._id).toEqual({ $gt: "memory-1" });
  expect(receivedFilter.scopeId).toBe("acme");
});

test("Mongo vector store validates collections and scopes Atlas search", async () => {
  const calls = [];
  const vectorCollection = {
    updateOne: async (...args) => { calls.push(["upsert", ...args]); },
    aggregate: (pipeline) => { calls.push(["search", pipeline]); return { toArray: async () => [{ id: "v1", namespace: "memory", score: 0.9, metadata: { agentId: "a1" } }] }; },
    deleteOne: async (filter) => { calls.push(["delete", filter]); },
  };
  const store = new MongoAtlasVectorStore({ collection: () => vectorCollection }, "planet-vectors", { memory: { dimensions: 3, model: "embed-v1" } });
  const scope = { tenantId: "acme", workspaceId: "research" };
  await store.upsert({ id: "v1", namespace: "memory", embedding: [0.1, 0.2, 0.3], model: "embed-v1", metadata: { agentId: "a1" }, scope });
  expect(await store.search({ namespace: "memory", embedding: [0.1, 0.2, 0.3], metadata: { agentId: "a1" }, scope })).toEqual([{ id: "v1", namespace: "memory", metadata: { agentId: "a1" }, score: 0.9 }]);
  const filter = calls.find(([kind]) => kind === "search")[1][0].$vectorSearch.filter;
  expect(filter).toMatchObject({ namespace: "memory", scopeId: "acme:research", "metadata.agentId": "a1" });
  await store.delete({ id: "v1", namespace: "memory", scope });
  expect(calls.find(([kind]) => kind === "delete")[1]._id).toBe("acme:research:memory:v1");
  await expect(store.search({ namespace: "memory", embedding: [1, 2] })).rejects.toThrow("dimension mismatch");
  await expect(store.search({ namespace: "memory", embedding: [1, 2, 3], metadata: { "not.safe": "x" } })).rejects.toThrow("Unsupported vector metadata filter key");
});

test("Mongo queue, stack, and key/value stores handle scoped lifecycle operations", async () => {
  const calls = [];
  const timestamp = new Date("2025-01-01T00:00:00.000Z");
  const queueMessages = {
    insertOne: async (value) => { calls.push(["enqueue", value]); },
    findOneAndUpdate: async (...args) => { calls.push(["claim", ...args]); return { _id: "q1", queue: "jobs", value: { task: "index" }, attempts: 2, availableAt: timestamp, leaseToken: "lease-1", leaseUntil: new Date(timestamp.getTime() + 5000) }; },
    deleteOne: async (filter) => { calls.push(["ack", filter]); return { deletedCount: 1 }; },
    updateOne: async (...args) => { calls.push(["release", ...args]); return { modifiedCount: 1 }; },
  };
  const entries = {
    insertOne: async (value) => { calls.push(["push", value]); },
    findOneAndDelete: async (...args) => { calls.push(["pop", ...args]); return { value: { undo: true } }; },
    find: (filter) => { calls.push(["peek", filter]); return { sort() { return this; }, limit() { return this; }, async next() { return { value: { undo: true } }; } }; },
    countDocuments: async (filter) => { calls.push(["size", filter]); return 2; },
  };
  const counters = { findOneAndUpdate: async (...args) => { calls.push(["counter", ...args]); return { sequence: 1 }; } };
  const keyValues = {
    replaceOne: async (...args) => { calls.push(["set", ...args]); },
    findOne: async (filter) => { calls.push(["get", filter]); return { value: { userId: "u1" }, expiresAt: timestamp }; },
    deleteOne: async (filter) => { calls.push(["delete", filter]); return { deletedCount: 1 }; },
  };
  const db = { collection: (name) => ({ queue_messages: queueMessages, stack_entries: entries, stack_counters: counters, key_values: keyValues })[name] };
  const scope = { tenantId: "acme", workspaceId: "research" };

  const queue = new MongoQueueStore(db);
  expect(await queue.enqueue({ queue: "jobs", value: { task: "index" }, scope })).toMatchObject({ queue: "jobs", attempts: 0 });
  expect(await queue.claim({ queue: "jobs", scope })).toMatchObject([{ id: "q1", attempts: 2 }]);
  expect(await queue.ack({ queue: "jobs", id: "q1", leaseToken: "lease-1", scope })).toBe(true);
  expect(await queue.release({ queue: "jobs", id: "q1", leaseToken: "lease-1", delayMs: 10, scope })).toBe(true);
  expect(calls.find(([kind]) => kind === "claim")[1]).toMatchObject({ scopeId: "acme:research", queue: "jobs" });

  const stack = new MongoStackStore(db);
  await stack.push({ stack: "undo", value: { undo: true }, scope });
  expect(await stack.pop({ stack: "undo", scope })).toEqual({ undo: true });
  expect(await stack.peek({ stack: "undo", scope })).toEqual({ undo: true });
  expect(await stack.size({ stack: "undo", scope })).toBe(2);

  const keyValue = new MongoKeyValueStore(db);
  await keyValue.set({ namespace: "session", key: "s1", value: { userId: "u1" }, ttlMs: 1000, scope });
  expect(await keyValue.get({ namespace: "session", key: "s1", scope })).toEqual({ value: { userId: "u1" }, expiresAt: timestamp });
  expect(await keyValue.delete({ namespace: "session", key: "s1", scope })).toBe(true);
  expect(calls.filter(([kind]) => ["set", "get", "delete"].includes(kind)).every(([, filterOrValue]) => JSON.stringify(filterOrValue).includes("acme:research"))).toBe(true);
});
