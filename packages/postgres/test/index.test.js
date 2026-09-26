import { expect, test } from "bun:test";
import { createPostgresProvider, PgVectorStore, PostgresKeyValueStore, PostgresQueueStore, PostgresSqlStore, PostgresStackStore } from "../dist/index.js";

test("commits a callback through a pooled PostgreSQL connection", async () => {
  const statements = [];
  let released = false;
  const connection = {
    query: async (text, values) => {
      statements.push([text, values]);
      return text.startsWith("SELECT") ? { rows: [{ value: values[0] }], rowCount: 1 } : { rows: [], rowCount: null };
    },
    release: () => { released = true; },
  };
  const store = new PostgresSqlStore({ query: connection.query, connect: async () => connection });
  const result = await store.transaction((transaction) => transaction.query({ text: "SELECT $1 AS value", values: ["planet"] }));
  expect(result.rows).toEqual([{ value: "planet" }]);
  expect(statements.map(([text]) => text)).toEqual(["BEGIN", "SELECT $1 AS value", "COMMIT"]);
  expect(released).toBe(true);
});

test("rolls back and releases a failed transaction", async () => {
  const statements = [];
  let released = false;
  const connection = {
    query: async (text) => { statements.push(text); return { rows: [], rowCount: null }; },
    release: () => { released = true; },
  };
  const store = new PostgresSqlStore({ query: connection.query, connect: async () => connection });
  await expect(store.transaction(async () => { throw new Error("stop"); })).rejects.toThrow("stop");
  expect(statements).toEqual(["BEGIN", "ROLLBACK"]);
  expect(released).toBe(true);
});

test("PostgreSQL queue, stack, and key/value stores preserve scope and map results", async () => {
  const calls = [];
  const now = new Date("2025-01-01T00:00:00.000Z");
  const db = { query: async (text, values = []) => {
    calls.push({ text, values });
    if (text.startsWith("INSERT INTO queue_messages")) return { rows: [{ id: "q1", queue_name: "jobs", payload: { task: "index" }, attempts: 0, available_at: now }], rowCount: 1 };
    if (text.startsWith("WITH due AS")) return { rows: [{ id: "q1", queue_name: "jobs", payload: { task: "index" }, attempts: 1, available_at: now, lease_token: "00000000-0000-4000-8000-000000000001", lease_until: new Date(now.getTime() + 2000) }], rowCount: 1 };
    if (text.startsWith("WITH top AS")) return { rows: [{ value: { undo: true } }], rowCount: 1 };
    if (text.startsWith("SELECT value FROM stack_entries")) return { rows: [{ value: { undo: true } }], rowCount: 1 };
    if (text.startsWith("SELECT count(*)")) return { rows: [{ count: "3" }], rowCount: 1 };
    if (text.startsWith("SELECT value,expires_at")) return { rows: [{ value: { userId: "u1" }, expires_at: now }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  } };
  const scope = { tenantId: "acme", workspaceId: "research" };
  const queue = new PostgresQueueStore(db);
  expect(await queue.enqueue({ queue: "jobs", value: { task: "index" }, delayMs: 25, scope })).toMatchObject({ id: "q1", value: { task: "index" }, attempts: 0 });
  const [claimed] = await queue.claim({ queue: "jobs", limit: 2, leaseMs: 2000, scope });
  expect(claimed).toMatchObject({ id: "q1", attempts: 1 });
  expect(await queue.ack({ queue: "jobs", id: "q1", leaseToken: claimed.leaseToken, scope })).toBe(true);
  expect(await queue.release({ queue: "jobs", id: "q1", leaseToken: claimed.leaseToken, delayMs: 50, scope })).toBe(true);
  expect(calls.slice(0, 4).every(({ values }) => values.includes("acme:research"))).toBe(true);

  const stack = new PostgresStackStore(db);
  await stack.push({ stack: "undo", value: { undo: true }, scope });
  expect(await stack.pop({ stack: "undo", scope })).toEqual({ undo: true });
  expect(await stack.peek({ stack: "undo", scope })).toEqual({ undo: true });
  expect(await stack.size({ stack: "undo", scope })).toBe(3);

  const keyValue = new PostgresKeyValueStore(db);
  await keyValue.set({ namespace: "session", key: "s1", value: { userId: "u1" }, ttlMs: 5000, scope });
  expect(await keyValue.get({ namespace: "session", key: "s1", scope })).toEqual({ value: { userId: "u1" }, expiresAt: now });
  expect(await keyValue.delete({ namespace: "session", key: "s1", scope })).toBe(true);
  expect(calls.slice(-3).every(({ values }) => values.includes("acme:research"))).toBe(true);
});

test("PostgreSQL vectors validate configured models and pass scoped filters", async () => {
  const calls = [];
  const db = { query: async (text, values = []) => { calls.push({ text, values }); return { rows: [{ id: "v1", namespace: "memory", score: 0.9, metadata: { agentId: "a1" } }], rowCount: 1 }; } };
  const vectors = new PgVectorStore(db, { memory: { dimensions: 3, model: "embed-v1" } });
  const scope = { tenantId: "acme" };
  await vectors.upsert({ id: "v1", namespace: "memory", model: "embed-v1", embedding: [0.1, 0.2, 0.3], scope });
  expect(await vectors.search({ namespace: "memory", model: "embed-v1", embedding: [0.1, 0.2, 0.3], metadata: { agentId: "a1" }, scope })).toEqual([{ id: "v1", namespace: "memory", score: 0.9, metadata: { agentId: "a1" } }]);
  expect(calls[1].text).toContain("metadata @>");
  expect(calls[1].values).toContain("acme");
  await vectors.delete({ id: "v1", namespace: "memory", scope });
  await expect(vectors.upsert({ id: "v2", namespace: "memory", model: "embed-v1", embedding: [1, 2], scope })).rejects.toThrow("Embedding dimension mismatch");
});

test("PostgreSQL provider routes each feature to its configured schema", async () => {
  const queries = [];
  const provider = createPostgresProvider({
    database: { query: async (text) => { queries.push(text); return { rows: [], rowCount: 0 }; } },
    schema: "app_default",
    schemas: {
      graph: "app_graph",
      documents: "app_graph",
      chunks: "app_graph",
      evidence: "app_graph",
      vector: "app_vectors",
      memories: "app_memories",
      ingestionJobs: "app_jobs",
      identities: "app_identity",
      queue: "app_queue",
      stack: "app_stack",
      keyValue: "app_kv",
    },
  });
  await provider.graph.getNode("node");
  await provider.vector.delete({ id: "vector", namespace: "memory" });
  await provider.documents.get("document");
  await provider.chunks.get("chunk");
  await provider.evidence.list({ edgeId: "edge" });
  await provider.memories.get("memory");
  await provider.ingestionJobs.get("job");
  await provider.identities.get({ namespace: "actors", name: "alice" });
  await provider.queue.ack({ queue: "jobs", id: "job", leaseToken: "00000000-0000-4000-8000-000000000001" });
  await provider.stack.size({ stack: "undo" });
  await provider.keyValue.delete({ key: "session" });
  expect(queries).toHaveLength(11);
  expect(queries[0]).toContain('"app_graph".nodes');
  expect(queries[1]).toContain('"app_vectors".vectors');
  expect(queries[2]).toContain('"app_graph".documents');
  expect(queries[3]).toContain('"app_graph".document_chunks');
  expect(queries[4]).toContain('"app_graph".evidence');
  expect(queries[5]).toContain('"app_memories".memories');
  expect(queries[6]).toContain('"app_jobs".ingestion_jobs');
  expect(queries[7]).toContain('"app_identity".identities');
  expect(queries[8]).toContain('"app_queue".queue_messages');
  expect(queries[9]).toContain('"app_stack".stack_entries');
  expect(queries[10]).toContain('"app_kv".key_values');
  expect(() => createPostgresProvider({ database: { query: async () => ({ rows: [], rowCount: 0 }) }, schemas: { graph: "graph_data", evidence: "evidence_data" } })).toThrow("must use the same schema");
  expect(() => createPostgresProvider({ database: { query: async () => ({ rows: [], rowCount: 0 }) }, schemas: { memories: "bad-name" } })).toThrow("simple identifiers");
});

test("PostgreSQL SQL capability uses its configured schema as search path", async () => {
  const queries = [];
  const database = {
    query: async (text) => { queries.push(text); return { rows: [], rowCount: 0 }; },
    connect: async () => ({ query: async (text) => { queries.push(text); return { rows: [], rowCount: 0 }; }, release: () => {} }),
  };
  const provider = createPostgresProvider({ database, schemas: { sql: "reporting" } });
  await provider.sql.query({ text: "SELECT current_schema()" });
  expect(queries).toEqual(["BEGIN", 'SET LOCAL search_path TO "reporting", public', "SELECT current_schema()", "COMMIT"]);
});
