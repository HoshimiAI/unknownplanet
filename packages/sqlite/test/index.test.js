import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createSQLiteProvider } from "../dist/index.js";

const asBetterSqliteDatabase = (database) => ({
  exec: (sql) => database.exec(sql),
  prepare: (sql) => {
    const statement = database.prepare(sql);
    const bind = (values) => values.length === 1 && values[0] && typeof values[0] === "object" && !Array.isArray(values[0])
      ? [...sql.matchAll(/[@:$]([A-Za-z_]\w*)/g)].map((match) => values[0][match[1]])
      : values;
    return {
      run: (...values) => statement.run(...bind(values)),
      get: (...values) => statement.get(...bind(values)),
      all: (...values) => statement.all(...bind(values)),
    };
  },
});

test("SQLite persists scoped graph edges and cascading evidence", async () => {
  const database = new Database(":memory:");
  try {
    const db = asBetterSqliteDatabase(database);
    const provider = createSQLiteProvider({ database: db });
    const scope = { tenantId: "acme", workspaceId: "research" };
    const otherScope = { tenantId: "other" };
    const source = await provider.graph.createNode({ id: "source", type: "concept", name: "Attention", properties: { rank: 1 }, embedding: [0.2, 0.4], scope });
    await provider.graph.createNode({ id: "target", type: "method", name: "Transformer", scope });
    await provider.graph.createNode({ id: "source", type: "concept", name: "Different tenant", scope: otherScope });
    const edge = await provider.graph.createEdge({ id: "edge", from: "source", to: "target", relation: "USES", confidence: 0.8, scope });
    await provider.evidence.add({ id: "evidence", edgeId: edge.id, sourceId: "paper-1", extractor: "test", direction: "support", confidence: 0.9, scope });

    expect(await provider.graph.getNode("source", scope)).toMatchObject({ name: "Attention", properties: { rank: 1 }, embedding: [0.2, 0.4] });
    expect(await provider.graph.getNode("source", otherScope)).toMatchObject({ name: "Different tenant" });
    expect((await provider.graph.traverse({ startIds: ["source"], depth: 1, scope })).nodes.map(({ id }) => id).sort()).toEqual(["source", "target"]);
    expect(await provider.evidence.list({ edgeId: "edge", scope })).toHaveLength(1);
    expect(await provider.graph.deleteNode("source", scope)).toBe(true);
    expect(await provider.graph.getEdge("edge", scope)).toBeNull();
    expect(await provider.evidence.list({ edgeId: "edge", scope })).toEqual([]);
  } finally {
    database.close();
  }
});

test("SQLite provider reuses schema initialization and rejects dangling edges", async () => {
  const database = new Database(":memory:");
  try {
    const db = asBetterSqliteDatabase(database);
    const provider = createSQLiteProvider({ id: "local", database: db });
    expect(createSQLiteProvider({ id: "again", database: db }).id).toBe("again");
    await expect(provider.graph.createEdge({ from: "missing", to: "also-missing", relation: "LINKS" })).rejects.toThrow();
  } finally {
    database.close();
  }
});

test("SQLite graph and evidence support updates, filters, traversal, and explicit deletion", async () => {
  const database = new Database(":memory:");
  try {
    const provider = createSQLiteProvider({ database: asBetterSqliteDatabase(database) });
    const scope = { tenantId: "tenant-a" };
    const start = await provider.graph.createNode({ id: "a", type: "concept", name: "Start", scope });
    await provider.graph.createNode({ id: "b", type: "method", name: "Attention", scope });
    const otherScope = { tenantId: "tenant-b" };
    await provider.graph.createNode({ id: "c", type: "method", name: "Hidden", scope: otherScope });

    const updated = await provider.graph.updateNode(start.id, { name: "Start Node", properties: { version: 2 }, embedding: [1, 0], scope });
    expect(updated).toMatchObject({ name: "Start Node", properties: { version: 2 }, embedding: [1, 0] });
    expect(await provider.graph.updateNode("missing", { name: "Missing", scope })).toBeNull();
    expect(await provider.graph.searchNodes({ query: "attention", scope })).toHaveLength(1);

    const edge = await provider.graph.createEdge({ id: "edge-ab", from: "a", to: "b", relation: "USES", scope });
    const future = new Date(Date.now() + 60_000);
    expect(await provider.graph.updateEdge(edge.id, { confidence: 0.7, status: "canonical", validFrom: new Date(0), validTo: future, scope })).toMatchObject({ confidence: 0.7, status: "canonical" });
    expect(await provider.graph.getEdge("missing", scope)).toBeNull();
    expect(await provider.graph.neighbors({ nodeId: "a", direction: "outbound", relation: "USES", scope })).toHaveLength(1);
    expect(await provider.graph.neighbors({ nodeId: "b", direction: "inbound", relation: "OTHER", scope })).toEqual([]);
    expect((await provider.graph.traverse({ startIds: ["a"], depth: 1, scope })).depthByNode).toEqual({ a: 0, b: 1 });

    await provider.evidence.add({ id: "ev-doc", edgeId: edge.id, documentId: "doc-1", chunkId: "chunk-1", extractor: "test", scope });
    await provider.evidence.add({ id: "ev-source", edgeId: edge.id, sourceId: "source-1", extractor: "test", scope });
    await provider.evidence.add({ id: "ev-chunk", edgeId: edge.id, sourceId: "source-2", chunkId: "chunk-2", extractor: "test", scope });
    expect(await provider.evidence.list({ edgeIds: [edge.id], documentId: "doc-1", scope })).toHaveLength(1);
    expect(await provider.evidence.deleteByDocument({ documentId: "doc-1", scope })).toBe(1);
    expect(await provider.evidence.deleteByChunks({ chunkIds: ["chunk-2"], scope })).toBe(1);
    expect(await provider.graph.deleteEdge(edge.id, scope)).toBe(true);
    expect(await provider.graph.deleteEdge(edge.id, scope)).toBe(false);
    expect(await provider.graph.getNode("c", scope)).toBeNull();
    expect(await provider.graph.deleteNode("b", scope)).toBe(true);
  } finally {
    database.close();
  }
});

test("SQLite schemas map routes graph and evidence tables independently", async () => {
  const database = new Database(":memory:");
  try {
    const provider = createSQLiteProvider({ database: asBetterSqliteDatabase(database), schemas: { graph: "tenant_graph", evidence: "tenant_evidence" } });
    const node = await provider.graph.createNode({ id: "a", type: "concept", name: "A" });
    await provider.evidence.list({});
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({ name }) => name)).toContain("tenant_graph_nodes");
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({ name }) => name)).toContain("tenant_evidence_evidence");
    expect(await provider.graph.getNode(node.id)).toMatchObject({ id: "a" });
    expect(() => createSQLiteProvider({ database: asBetterSqliteDatabase(database), schemas: { graph: "bad-name" } })).toThrow("simple identifier");
  } finally {
    database.close();
  }
});
