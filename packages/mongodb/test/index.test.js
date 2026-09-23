import { expect, test } from "bun:test";
import { MongoGraphStore } from "../dist/index.js";

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
