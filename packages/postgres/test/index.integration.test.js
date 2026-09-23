import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { PgVectorStore, PostgresDocumentChunkStore, PostgresDocumentStore, PostgresEvidenceStore, PostgresGraphStore, PostgresIdentityStore, PostgresIngestionJobStore, PostgresMemoryStore } from "../dist/index.js";

const connectionString = process.env.UP_TEST_DATABASE_URL;
const pool = connectionString ? new Pool({ connectionString }) : undefined;

if (pool) test("PostgreSQL persists scoped memory, vectors, graph links, chunks, and evidence", async () => {
  const scope = { tenantId: `test-${randomUUID()}` };
  const graph = new PostgresGraphStore(pool); const vectors = new PgVectorStore(pool);
  const documents = new PostgresDocumentStore(pool); const chunks = new PostgresDocumentChunkStore(pool);
  const evidence = new PostgresEvidenceStore(pool); const memories = new PostgresMemoryStore(pool);
  const memoryId = randomUUID(); const sourceNode = randomUUID(); const entityNode = randomUUID(); const edgeId = randomUUID(); const documentId = randomUUID(); const chunkId = randomUUID();
  try {
    const memory = await memories.add({ id: memoryId, agentId: "integration-agent", content: "Persistent memory", source: { type: "test", id: memoryId }, scope });
    await vectors.upsert({ id: memoryId, namespace: "memory", embedding: [0.1, 0.2, 0.3], metadata: { agentId: "integration-agent" }, scope });
    const hits = await vectors.search({ namespace: "memory", embedding: [0.1, 0.2, 0.3], metadata: { agentId: "integration-agent" }, scope });
    expect(hits.map((hit) => hit.id)).toContain(memoryId);
    expect((await memories.search({ agentId: "integration-agent", query: "Persistent", scope })).map((row) => row.id)).toContain(memoryId);
    await graph.createNode({ id: sourceNode, type: "memory", name: "Persistent memory", scope });
    await graph.createNode({ id: entityNode, type: "concept", name: "Persistence", scope });
    await graph.createEdge({ id: edgeId, from: sourceNode, to: entityNode, relation: "MENTIONS", scope });
    expect((await graph.traverse({ startIds: [sourceNode], depth: 1, scope })).nodes.map((node) => node.id)).toContain(entityNode);
    await documents.create({ id: documentId, title: "Integration", contentUri: "test://integration", scope });
    await chunks.create({ id: chunkId, documentId, text: "A durable chunk", startOffset: 0, endOffset: 15, scope });
    await evidence.add({ id: randomUUID(), edgeId, documentId, chunkId, sourceType: "document", extractor: "integration", direction: "support", confidence: 0.9, scope });
    expect((await evidence.list({ edgeId, scope }))[0]?.direction).toBe("support");
    expect((await documents.get(documentId, scope))?.id).toBe(documentId);
  } finally {
    await pool.query("DELETE FROM evidence WHERE scope_id=$1", [scope.tenantId]);
    await pool.query("DELETE FROM edges WHERE scope_id=$1", [scope.tenantId]);
    await pool.query("DELETE FROM vectors WHERE scope_id=$1", [scope.tenantId]);
    await pool.query("DELETE FROM memories WHERE scope_id=$1", [scope.tenantId]);
    await pool.query("DELETE FROM document_chunks WHERE scope_id=$1", [scope.tenantId]);
    await pool.query("DELETE FROM documents WHERE scope_id=$1", [scope.tenantId]);
    await pool.query("DELETE FROM nodes WHERE scope_id=$1", [scope.tenantId]);
  }
});

if (pool) test("PostgreSQL merges duplicate nodes atomically and preserves parallel edge evidence", async () => {
  const scope = { tenantId: `merge-${randomUUID()}` };
  const graph = new PostgresGraphStore(pool); const evidence = new PostgresEvidenceStore(pool);
  const source = randomUUID(); const target = randomUUID(); const neighbor = randomUUID();
  const oldEdge = randomUUID(); const canonicalEdge = randomUUID();
  try {
    await graph.createNode({ id: source, type: "ORG", name: "Open AI", scope });
    await graph.createNode({ id: target, type: "ORG", name: "OpenAI", scope });
    await graph.createNode({ id: neighbor, type: "METHOD", name: "Attention", scope });
    await graph.createEdge({ id: oldEdge, from: source, to: neighbor, relation: "USES", scope });
    await graph.createEdge({ id: canonicalEdge, from: target, to: neighbor, relation: "USES", scope });
    await evidence.add({ id: randomUUID(), edgeId: oldEdge, sourceId: "source-a", extractor: "test", scope });
    await evidence.add({ id: randomUUID(), edgeId: canonicalEdge, sourceId: "source-b", extractor: "test", scope });

    const merge = await graph.mergeNodes({ sourceId: source, targetId: target, scope });
    expect(merge).toMatchObject({ sourceId: source, targetId: target });
    expect(await graph.getNode(source, scope)).toBeNull();
    expect((await graph.neighbors({ nodeId: target, direction: "outbound", scope })).map((edge) => edge.id).sort()).toEqual([oldEdge, canonicalEdge].sort());
    expect((await evidence.list({ edgeId: oldEdge, scope })).map((item) => item.sourceId)).toEqual(["source-a"]);
    expect((await evidence.list({ edgeId: canonicalEdge, scope })).map((item) => item.sourceId)).toEqual(["source-b"]);
    expect(await graph.listMerges({ nodeId: target, scope })).toHaveLength(1);
  } finally {
    await pool.query("DELETE FROM evidence WHERE scope_id=$1", [scope.tenantId]);
    await pool.query("DELETE FROM edges WHERE scope_id=$1", [scope.tenantId]);
    await pool.query("DELETE FROM entity_merges WHERE scope_id=$1", [scope.tenantId]);
    await pool.query("DELETE FROM nodes WHERE scope_id=$1", [scope.tenantId]);
  }
});

if (pool) test("PostgreSQL serializes concurrent canonical identity creation", async () => {
  const scope = { tenantId: `identity-${randomUUID()}` }; const identities = new PostgresIdentityStore(pool);
  try {
    const [first, second] = await Promise.all([
      identities.resolveOrCreate({ namespace: "entity:ORG", name: "OpenAI", canonicalName: "openai", scope }),
      identities.resolveOrCreate({ namespace: "entity:ORG", name: "Open AI", canonicalName: "openai", scope }),
    ]);
    expect(first.id).toBe(second.id);
    expect((await identities.list({ namespace: "entity:ORG", scope }))).toHaveLength(1);
    expect((await identities.resolve({ namespace: "entity:ORG", name: "openai", scope }))?.id).toBe(first.id);
  } finally {
    await pool.query("DELETE FROM identity_aliases WHERE scope_id=$1", [scope.tenantId]);
    await pool.query("DELETE FROM identity_bindings WHERE scope_id=$1", [scope.tenantId]);
    await pool.query("DELETE FROM identities WHERE scope_id=$1", [scope.tenantId]);
  }
});

if (pool) test("PostgreSQL durably schedules and atomically claims ingestion retries", async () => {
  const scope = { tenantId: `jobs-${randomUUID()}` }; const jobs = new PostgresIngestionJobStore(pool); const id = randomUUID();
  try {
    const created = await jobs.create({ id, kind: "document", input: { title: "retryable", contentType: "text/plain", dataBase64: "SGVsbG8=" }, scope });
    expect(created.status).toBe("queued");
    const [first] = await jobs.claimDue({ scope, limit: 10 });
    expect(first).toMatchObject({ id, status: "processing", attempts: 1 });
    await jobs.update({ id, status: "retry_wait", checkpoint: "chunks_saved", nextAttemptAt: new Date(Date.now() - 1000), leaseUntil: null, lastError: "temporary", scope });
    const [retry] = await jobs.claimDue({ scope, limit: 10 });
    expect(retry).toMatchObject({ id, status: "processing", attempts: 2, checkpoint: "chunks_saved" });
    expect(retry.lastError).toBe("temporary");
  } finally { await pool.query("DELETE FROM ingestion_jobs WHERE scope_id=$1", [scope.tenantId]); }
});

afterAll(async () => { await pool?.end(); });
