import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createNeo4jProvider, initializeNeo4jSchema } from "../dist/index.js";

const uri = process.env.UP_TEST_NEO4J_URI;
if (uri) test("Neo4j persists scoped graph traversal and evidence", async () => {
  const { driver, auth } = await import("neo4j-driver");
  const client = driver(uri, auth.basic(process.env.UP_TEST_NEO4J_USER ?? "neo4j", process.env.UP_TEST_NEO4J_PASSWORD ?? "unknownplanet"));
  const scope = { tenantId: `integration-${randomUUID()}` };
  const sourceId = randomUUID(); const targetId = randomUUID(); const edgeId = randomUUID();
  try {
    await initializeNeo4jSchema(client);
    const provider = createNeo4jProvider({ driver: client });
    await provider.graph.createNode({ id: sourceId, type: "concept", name: "Live Neo4j source", properties: { live: true }, scope });
    await provider.graph.createNode({ id: targetId, type: "method", name: "Live Neo4j target", scope });
    const edge = await provider.graph.createEdge({ id: edgeId, from: sourceId, to: targetId, relation: "TESTS", scope });
    await provider.evidence.add({ id: randomUUID(), edgeId, sourceId: "live-provider-test", extractor: "integration", confidence: 0.9, scope });
    expect(await provider.graph.getNode(sourceId, scope)).toMatchObject({ name: "Live Neo4j source", properties: { live: true } });
    expect(await provider.graph.neighbors({ nodeId: sourceId, direction: "outbound", scope })).toMatchObject([{ id: edge.id, targetId }]);
    expect((await provider.graph.traverse({ startIds: [sourceId], depth: 1, scope })).nodes.map((node) => node.id)).toContain(targetId);
    expect(await provider.evidence.list({ edgeId, scope })).toMatchObject([{ sourceId: "live-provider-test", confidence: 0.9 }]);
    expect(await provider.graph.deleteNode(sourceId, scope)).toBe(true);
    expect(await provider.evidence.list({ edgeId, scope })).toEqual([]);
  } finally {
    const provider = createNeo4jProvider({ driver: client });
    await provider.graph.deleteNode(targetId, scope);
    await client.close();
  }
});
