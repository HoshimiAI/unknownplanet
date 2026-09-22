import { expect, test } from "bun:test";
import { definePlanetExtension, Planet } from "./dist/index.js";

test("semantic search expands graph candidates and carries evidence", async () => {
  const first = { id: "a", type: "method", name: "Transformer", properties: {}, createdAt: new Date(), updatedAt: new Date() };
  const second = { id: "b", type: "method", name: "Self Attention", properties: {}, createdAt: new Date(), updatedAt: new Date() };
  const edge = { id: "e", sourceId: "a", targetId: "b", relation: "USES", properties: {}, createdAt: new Date(), updatedAt: new Date() };
  const planet = new Planet({
    providers: [{ id: "postgres", graph: {
      createNode: async () => first, getNode: async (id) => id === "a" ? first : second, updateNode: async () => first, deleteNode: async () => true,
      createEdge: async () => edge, getEdge: async () => edge, deleteEdge: async () => true, neighbors: async () => [edge], searchNodes: async () => [first],
      traverse: async () => ({ nodes: [first, second], edges: [edge], depthByNode: { a: 0, b: 1 } }),
    } }, { id: "qdrant", vector: { upsert: async () => {}, delete: async () => {}, search: async () => [{ id: "a", namespace: "node", score: 0.9, metadata: {} }] } }],
    routing: { graph: "postgres", vector: "qdrant" },
    embeddings: { embed: async () => [0.1, 0.2] },
    evidence: { add: async () => { throw new Error("unused"); }, list: async () => [{ id: "ev", edgeId: "e", documentId: "d", extractor: "test", metadata: {}, createdAt: new Date() }] },
    retrieval: { graphDecay: 0.5, ranker: ({ results }) => [...results].reverse() },
  });
  const result = await planet.graph.search({ query: "attention", semantic: true, graph: { depth: 1 } });
  expect(result.map((item) => item.node.id)).toEqual(["b", "a"]);
  expect(result[0].evidence[0].documentId).toBe("d");
});

test("routes parameterized SQL to a relational provider", async () => {
  const planet = new Planet({
    providers: [{
      id: "postgres",
      sql: { query: async ({ values }) => ({ rows: [{ id: values[0] }], rowCount: 1 }) },
    }],
    routing: { sql: "postgres" },
  });
  const result = await planet.sql.query({ text: "SELECT $1 AS id", values: ["project-1"] });
  expect(result).toEqual({ rows: [{ id: "project-1" }], rowCount: 1 });
});

test("routes package-defined extensions without changing the SDK", () => {
  const planet = new Planet({
    providers: [
      { id: "redis", extensions: { cache: { get: (key) => `cache:${key}` } } },
      { id: "local", extensions: { cache: { get: (key) => `local:${key}` } } },
    ],
    routing: { extensions: { cache: "redis" } },
  });
  const cache = planet.extension("cache");
  expect(cache.get("node-1")).toBe("cache:node-1");
});

test("forwards vector writes, deletes, and SQL transactions", async () => {
  const calls = [];
  const planet = new Planet({
    vector: {
      upsert: async (record) => { calls.push(["upsert", record.id]); },
      search: async () => [],
      delete: async (id) => { calls.push(["delete", id]); },
    },
    sql: {
      query: async () => ({ rows: [], rowCount: 0 }),
      transaction: async (work) => work({ query: async () => ({ rows: [{ ok: true }], rowCount: 1 }) }),
    },
    extensions: { cache: { get: (key) => `value:${key}` } },
  });
  await planet.vector.upsert({ id: "v1", namespace: "test", embedding: [0.1] });
  await planet.vector.delete("v1");
  const result = await planet.sql.transaction((transaction) => transaction.query({ text: "SELECT 1" }));
  const cache = planet.extension(definePlanetExtension("cache"));
  expect(calls).toEqual([["upsert", "v1"], ["delete", "v1"]]);
  expect(result.rows).toEqual([{ ok: true }]);
  expect(cache.get("a")).toBe("value:a");
});
