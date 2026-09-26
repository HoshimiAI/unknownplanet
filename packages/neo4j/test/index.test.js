import { expect, test } from "bun:test";
import { Neo4jGraphStore, createNeo4jProvider, initializeNeo4jSchema } from "../dist/index.js";

const record = (values) => ({ get: (key) => values[key] });

function inMemoryNeo4jDriver() {
  const nodes = new Map();
  const edges = new Map();
  const evidence = new Map();
  let closed = 0;
  const driver = { session: () => ({
    run: async (query, params = {}) => {
      const value = params.value;
      if (query.includes("CREATE (n:UPNode")) {
        const node = { ...value };
        nodes.set(node.id, node);
        return { records: [record({ node })] };
      }
      if (query.includes("OPTIONAL MATCH (n)-[r:UP_EDGE]-()")) {
        const ids = [...edges.values()].filter((edge) => edge.scopeId === params.scopeId && (edge.sourceId === params.id || edge.targetId === params.id)).map((edge) => edge.id);
        return { records: [record({ ids })] };
      }
      if (query.includes("DETACH DELETE n RETURN count(*)")) {
        const exists = nodes.get(params.id)?.scopeId === params.scopeId;
        if (exists) nodes.delete(params.id);
        for (const [id, edge] of edges) if (edge.scopeId === params.scopeId && (edge.sourceId === params.id || edge.targetId === params.id)) edges.delete(id);
        for (const [id, item] of evidence) if (item.scopeId === params.scopeId && !edges.has(item.edgeId)) evidence.delete(id);
        return { records: [record({ count: exists ? 1 : 0 })] };
      }
      if (query.includes("CREATE (s)-[r:UP_EDGE")) {
        if (!nodes.has(params.from) || !nodes.has(params.to)) return { records: [] };
        const edge = { ...value };
        edges.set(edge.id, edge);
        return { records: [record({ edge })] };
      }
      if (query.includes("CREATE (e:UPEvidence")) {
        if (!edges.has(params.edgeId)) return { records: [] };
        const item = { ...value };
        evidence.set(item.id, item);
        return { records: [record({ evidence: item })] };
      }
      if (query.includes("MATCH (n:UPNode {id:$id,scopeId:$scopeId})") && query.includes("RETURN n AS node") && !query.includes("SET n += $value")) {
        const node = nodes.get(params.id);
        return { records: node?.scopeId === params.scopeId ? [record({ node })] : [] };
      }
      if (query.includes("SET n += $value")) {
        const node = nodes.get(params.id);
        if (!node || node.scopeId !== params.scopeId) return { records: [] };
        Object.assign(node, value);
        return { records: [record({ node })] };
      }
      if (query.includes("MATCH ()-[r:UP_EDGE") && query.includes("RETURN r AS edge") && !query.includes("SET r += $value")) {
        const edge = edges.get(params.id);
        return { records: edge?.scopeId === params.scopeId ? [record({ edge })] : [] };
      }
      if (query.includes("SET r += $value")) {
        const edge = edges.get(params.id);
        if (!edge || edge.scopeId !== params.scopeId) return { records: [] };
        Object.assign(edge, value);
        return { records: [record({ edge })] };
      }
      if (query.includes("DELETE r RETURN count(*)")) {
        const edge = edges.get(params.id);
        const deleted = edge?.scopeId === params.scopeId;
        if (deleted) edges.delete(params.id);
        for (const [id, item] of evidence) if (item.scopeId === params.scopeId && item.edgeId === params.id) evidence.delete(id);
        return { records: [record({ count: deleted ? 1 : 0 })] };
      }
      if (query.includes("MATCH (e:UPEvidence {scopeId:$scopeId,documentId:$documentId})")) {
        const removed = [...evidence.values()].filter((item) => item.scopeId === params.scopeId && item.documentId === params.documentId);
        for (const item of removed) evidence.delete(item.id);
        return { records: [record({ count: removed.length })] };
      }
      if (query.includes("MATCH (e:UPEvidence {scopeId:$scopeId}) WHERE e.chunkId IN $chunkIds")) {
        const removed = [...evidence.values()].filter((item) => item.scopeId === params.scopeId && params.chunkIds.includes(item.chunkId));
        for (const item of removed) evidence.delete(item.id);
        return { records: [record({ count: removed.length })] };
      }
      if (query.includes("MATCH (e:UPEvidence)")) {
        const rows = [...evidence.values()].filter((item) => item.scopeId === params.scopeId && (!params.edgeId || item.edgeId === params.edgeId) && (!params.documentId || item.documentId === params.documentId));
        return { records: rows.slice(0, params.limit).map((item) => record({ evidence: item })) };
      }
      if (query.includes("RETURN r AS edge ORDER BY")) {
        const rows = [...edges.values()].filter((edge) => edge.scopeId === params.scopeId && (edge.sourceId === params.nodeId || edge.targetId === params.nodeId) && (!params.relation || edge.relation === params.relation));
        return { records: rows.map((edge) => record({ edge })) };
      }
      if (query.includes("RETURN n AS node ORDER BY n.name")) {
        const rows = [...nodes.values()].filter((node) => node.scopeId === params.scopeId && node.name.toLowerCase().includes(params.query.toLowerCase()));
        return { records: rows.slice(0, params.limit).map((node) => record({ node })) };
      }
      return { records: [] };
    },
    close: async () => { closed += 1; },
  }) };
  return { driver, nodes, edges, evidence, get closed() { return closed; } };
}

test("Neo4j stores graph properties as JSON and closes each session", async () => {
  const calls = [];
  let closed = 0;
  const node = { id: "n1", type: "concept", name: "Attention", propertiesJson: '{"source":"test"}', embeddingJson: "[0.1,0.2]", createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z" };
  const driver = { session: (config) => ({ run: async (query, params) => { calls.push({ config, query, params }); return { records: [record({ node })] }; }, close: async () => { closed += 1; } }) };
  const provider = createNeo4jProvider({ driver, database: "neo4j" });
  const result = await provider.graph.createNode({ id: "n1", type: "concept", name: "Attention", properties: { source: "test" }, embedding: [0.1, 0.2], scope: { tenantId: "acme", workspaceId: "research" } });

  expect(result).toMatchObject({ id: "n1", properties: { source: "test" }, embedding: [0.1, 0.2] });
  expect(calls[0].config).toEqual({ database: "neo4j" });
  expect(calls[0].query).toContain("CREATE (n:UPNode $value)");
  expect(calls[0].params.value.scopeId).toBe('["acme","research"]');
  expect(JSON.parse(calls[0].params.value.propertiesJson)).toEqual({ source: "test" });
  expect(closed).toBe(1);
});

test("Neo4j initializes scoped schema constraints and closes on query failure", async () => {
  const queries = [];
  let closed = 0;
  const driver = { session: () => ({ run: async (query) => { queries.push(query); if (query.includes("CREATE INDEX up_edge")) throw new Error("index failed"); return { records: [] }; }, close: async () => { closed += 1; } }) };
  await expect(initializeNeo4jSchema(driver)).rejects.toThrow("index failed");
  expect(queries[0]).toContain("up_node_scope_id");
  expect(queries).toHaveLength(2);
  expect(closed).toBe(1);
  let lookup;
  const store = new Neo4jGraphStore({ session: () => ({ run: async (query, params) => { lookup = { query, params }; return { records: [] }; }, close: async () => { closed += 1; } }) });
  expect(await store.getNode("missing", { tenantId: "acme" })).toBeNull();
  expect(lookup.query).toContain("scopeId:$scopeId");
  expect(lookup.params.scopeId).toBe('["acme",null]');
  expect(closed).toBe(2);
});

test("Neo4j schemas map namespaces to labels and relationship types", async () => {
  let queryText = "";
  const driver = { session: () => ({ run: async (query) => { queryText = query; return { records: [] }; }, close: async () => {} }) };
  const provider = createNeo4jProvider({ driver, schemas: { graph: "tenant_graph", evidence: "tenant_evidence" } });
  expect(await provider.graph.getNode("missing")).toBeNull();
  expect(queryText).toContain(":tenant_graph_UPNode");
  await provider.evidence.list({});
  expect(queryText).toContain(":tenant_evidence_UPEvidence");
  expect(() => createNeo4jProvider({ driver, schemas: { graph: "bad-label" } })).toThrow("simple identifier");
});

test("Neo4j graph and evidence cover scoped CRUD, traversal, filtering, and cleanup", async () => {
  const fake = inMemoryNeo4jDriver();
  const provider = createNeo4jProvider({ driver: fake.driver });
  const scope = { tenantId: "acme", workspaceId: "research" };
  await provider.graph.createNode({ id: "a", type: "concept", name: "Attention", scope });
  await provider.graph.createNode({ id: "b", type: "method", name: "Transformer", scope });
  await provider.graph.createNode({ id: "hidden", type: "concept", name: "Attention", scope: { tenantId: "other" } });
  expect(await provider.graph.getNode("hidden", scope)).toBeNull();
  expect(await provider.graph.updateNode("a", { name: "Self Attention", scope })).toMatchObject({ name: "Self Attention" });
  expect(await provider.graph.searchNodes({ query: "attention", scope })).toMatchObject([{ id: "a", name: "Self Attention" }]);
  const edge = await provider.graph.createEdge({ id: "edge-ab", from: "a", to: "b", relation: "USES", confidence: 0.8, scope });
  expect(await provider.graph.getEdge(edge.id, scope)).toMatchObject({ sourceId: "a", targetId: "b", confidence: 0.8 });
  expect(await provider.graph.updateEdge(edge.id, { status: "canonical", scope })).toMatchObject({ status: "canonical" });
  expect(await provider.graph.neighbors({ nodeId: "a", direction: "outbound", relation: "USES", scope })).toHaveLength(1);
  expect((await provider.graph.traverse({ startIds: ["a"], depth: 1, scope })).depthByNode).toEqual({ a: 0, b: 1 });
  await provider.evidence.add({ id: "evidence-doc", edgeId: edge.id, documentId: "doc-1", chunkId: "chunk-1", extractor: "test", scope });
  await provider.evidence.add({ id: "evidence-source", edgeId: edge.id, sourceId: "source-1", extractor: "test", scope });
  expect(await provider.evidence.list({ edgeId: edge.id, documentId: "doc-1", scope })).toHaveLength(1);
  expect(await provider.evidence.deleteByChunks({ chunkIds: ["chunk-1"], scope })).toBe(1);
  expect(await provider.evidence.deleteByDocument({ documentId: "doc-1", scope })).toBe(0);
  expect(await provider.graph.deleteEdge(edge.id, scope)).toBe(true);
  expect(await provider.graph.deleteEdge(edge.id, scope)).toBe(false);
  expect(await provider.graph.deleteNode("a", scope)).toBe(true);
  expect(await provider.graph.getNode("a", scope)).toBeNull();
  expect(fake.closed).toBeGreaterThan(10);
});
