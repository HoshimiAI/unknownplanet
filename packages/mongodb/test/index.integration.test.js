import { expect, test } from "bun:test";
import { MongoClient } from "mongodb";
import { MongoDocumentChunkStore, MongoDocumentStore, MongoEvidenceStore, MongoGraphStore, MongoIngestionJobStore, MongoMemoryStore } from "../dist/index.js";

if (process.env.UP_TEST_MONGODB_URI) test("MongoDB persists scoped memory, graph, chunks, and source evidence", async () => {
  const client = new MongoClient(process.env.UP_TEST_MONGODB_URI);
  await client.connect();
  const db = client.db(`unknownplanet_test_${crypto.randomUUID().replaceAll("-", "")}`);
  const scope = { tenantId: "tenant-a", workspaceId: "integration" };
  const graph = new MongoGraphStore(db); const memories = new MongoMemoryStore(db);
  const documents = new MongoDocumentStore(db); const chunks = new MongoDocumentChunkStore(db); const evidence = new MongoEvidenceStore(db);
  try {
    await memories.add({ id: "memory-1", agentId: "agent-a", content: "Persistent Mongo memory", scope });
    expect((await memories.search({ agentId: "agent-a", query: "Mongo", scope })).map((record) => record.id)).toEqual(["memory-1"]);
    await graph.createNode({ id: "from", type: "concept", name: "From", scope });
    await graph.createNode({ id: "to", type: "concept", name: "To", scope });
    await graph.createNode({ id: "from-b", type: "concept", name: "From B", scope: { tenantId: "tenant-b" } });
    await graph.createNode({ id: "other", type: "concept", name: "Other", scope: { tenantId: "tenant-b" } });
    await graph.createEdge({ id: "edge-a", from: "from", to: "to", relation: "LINKS", scope });
    await graph.createEdge({ id: "edge-b", from: "from-b", to: "other", relation: "LINKS", scope: { tenantId: "tenant-b" } });
    expect((await graph.neighbors({ nodeId: "from", scope })).map((edge) => edge.id)).toEqual(["edge-a"]);
    expect((await graph.traverse({ startIds: ["from"], depth: 1, scope })).nodes.map((node) => node.id).sort()).toEqual(["from", "to"]);
    expect((await graph.searchNodes({ query: "Other", scope })).map((node) => node.id)).toEqual([]);
    await documents.create({ id: "doc-1", title: "Doc", contentUri: "test://doc", scope });
    await chunks.create({ id: "chunk-1", documentId: "doc-1", text: "Evidence source", scope });
    await evidence.add({ id: "evidence-1", edgeId: "edge-a", documentId: "doc-1", chunkId: "chunk-1", extractor: "test", direction: "support", scope });
    expect((await evidence.list({ edgeId: "edge-a", scope }))[0]?.direction).toBe("support");
  } finally {
    await client.db(db.databaseName).dropDatabase();
    await client.close();
  }
});

if (process.env.UP_TEST_MONGODB_URI) test("MongoDB atomically merges nodes and retains merge snapshots and parallel edges", async () => {
  const client = new MongoClient(process.env.UP_TEST_MONGODB_URI);
  await client.connect();
  const db = client.db(`unknownplanet_merge_test_${crypto.randomUUID().replaceAll("-", "")}`);
  const scope = { tenantId: "tenant-merge" }; const graph = new MongoGraphStore(db); const evidence = new MongoEvidenceStore(db);
  try {
    await graph.createNode({ id: "duplicate", type: "ORG", name: "Open AI", properties: { aliases: ["Open A.I."] }, scope });
    await graph.createNode({ id: "canonical", type: "ORG", name: "OpenAI", scope });
    await graph.createNode({ id: "method", type: "METHOD", name: "Attention", scope });
    await graph.createEdge({ id: "old-edge", from: "duplicate", to: "method", relation: "USES", scope });
    await graph.createEdge({ id: "canonical-edge", from: "canonical", to: "method", relation: "USES", scope });
    await evidence.add({ id: "old-evidence", edgeId: "old-edge", sourceId: "source-old", extractor: "test", scope });
    const merge = await graph.mergeNodes({ sourceId: "duplicate", targetId: "canonical", scope });
    expect(merge.source.properties.aliases).toEqual(["Open A.I."]);
    expect(merge.targetAfter.properties.aliases).toContain("Open AI");
    expect(await graph.getNode("duplicate", scope)).toBeNull();
    expect((await graph.neighbors({ nodeId: "canonical", direction: "outbound", scope })).map((edge) => edge.id).sort()).toEqual(["canonical-edge", "old-edge"]);
    expect((await evidence.list({ edgeId: "old-edge", scope })).map((row) => row.sourceId)).toEqual(["source-old"]);
    expect((await graph.listMerges({ nodeId: "canonical", scope }))[0]?.source.name).toBe("Open AI");
  } finally {
    await client.db(db.databaseName).dropDatabase();
    await client.close();
  }
});

if (process.env.UP_TEST_MONGODB_URI) test("MongoDB durably schedules and atomically claims ingestion retries", async () => {
  const client = new MongoClient(process.env.UP_TEST_MONGODB_URI);
  await client.connect();
  const db = client.db(`unknownplanet_jobs_test_${crypto.randomUUID().replaceAll("-", "")}`);
  const scope = { tenantId: "tenant-jobs" }; const jobs = new MongoIngestionJobStore(db);
  try {
    const created = await jobs.create({ id: "job-1", kind: "document", input: { title: "retryable", contentType: "text/plain", dataBase64: "SGVsbG8=" }, scope });
    expect(created.status).toBe("queued");
    const [first] = await jobs.claimDue({ scope, limit: 10 });
    expect(first).toMatchObject({ id: "job-1", status: "processing", attempts: 1 });
    await jobs.update({ id: "job-1", status: "retry_wait", checkpoint: "chunks_saved", nextAttemptAt: new Date(Date.now() - 1000), leaseUntil: null, lastError: "temporary", scope });
    const [retry] = await jobs.claimDue({ scope, limit: 10 });
    expect(retry).toMatchObject({ id: "job-1", status: "processing", attempts: 2, checkpoint: "chunks_saved" });
    expect(retry.lastError).toBe("temporary");
  } finally {
    await client.db(db.databaseName).dropDatabase();
    await client.close();
  }
});
