import { expect, test } from "bun:test";
import { definePlanetExtension, Planet, PlanetCapabilityError, PlanetConflictError, PlanetNotFoundError } from "../dist/index.js";

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

test("missing capabilities raise a stable typed SDK error", async () => {
  const planet = new Planet({});
  await expect(planet.memory.search({})).rejects.toBeInstanceOf(PlanetCapabilityError);
  await expect(planet.memory.search({})).rejects.toMatchObject({ code: "capability_unavailable", statusCode: 503 });
});

test("node merge checks scoped endpoints before dispatching the audited merge", async () => {
  const calls = []; const now = new Date();
  const node = (id) => ({ id, type: "ORG", name: id, properties: {}, createdAt: now, updatedAt: now });
  const graph = {
    getNode: async (id, scope) => { calls.push(["get", id, scope.tenantId]); return id === "missing" ? null : node(id); },
    mergeNodes: async (input) => { calls.push(["merge", input.sourceId, input.targetId, input.scope.tenantId]); return { sourceId: input.sourceId, targetId: input.targetId, mergedAt: now }; },
    listMerges: async (input) => [{ sourceId: "duplicate", targetId: "canonical", mergedAt: now, scope: input.scope }],
  };
  const planet = new Planet({ graph }).withScope({ tenantId: "tenant-a" });
  await expect(planet.graph.node.merge({ sourceId: "same", targetId: "same" })).rejects.toBeInstanceOf(PlanetConflictError);
  await expect(planet.graph.node.merge({ sourceId: "missing", targetId: "canonical" })).rejects.toBeInstanceOf(PlanetNotFoundError);
  await expect(planet.graph.node.merge({ sourceId: "duplicate", targetId: "canonical" })).resolves.toMatchObject({ sourceId: "duplicate", targetId: "canonical" });
  expect(calls).toEqual([["get", "missing", "tenant-a"], ["get", "canonical", "tenant-a"], ["get", "duplicate", "tenant-a"], ["get", "canonical", "tenant-a"], ["merge", "duplicate", "canonical", "tenant-a"]]);
  expect(await planet.graph.node.merges({ nodeId: "canonical" })).toHaveLength(1);
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
  await planet.vector.delete({ id: "v1", namespace: "test" });
  const result = await planet.sql.transaction((transaction) => transaction.query({ text: "SELECT 1" }));
  const cache = planet.extension(definePlanetExtension("cache"));
  expect(calls).toEqual([["upsert", "v1"], ["delete", expect.objectContaining({ id: "v1", namespace: "test" })]]);
  expect(result.rows).toEqual([{ ok: true }]);
  expect(cache.get("a")).toBe("value:a");
});

test("routes scoped immutable identities to the catalog provider", async () => {
  const calls = [];
  const planet = new Planet({
    providers: [{ id: "catalog", identities: {
      create: async (input) => { calls.push(["create", input.scope.tenantId]); return { id: "i1", namespace: input.namespace, name: input.name, metadata: {}, createdAt: new Date() }; },
      get: async () => null,
      resolve: async (input) => ({ id: "i1", namespace: input.namespace, name: "canonical", metadata: {}, createdAt: new Date() }),
      addAlias: async (input) => { calls.push(["alias", input.alias]); },
      bind: async (input) => ({ identityId: input.identityId, providerId: input.providerId, resourceType: input.resourceType, resourceId: input.resourceId, metadata: {}, createdAt: new Date() }),
      listBindings: async () => [],
    } }],
    routing: { identities: "catalog" },
  }).withScope({ tenantId: "acme" });
  await planet.nameId.create({ namespace: "lunar.memory", name: "thread-1" });
  await planet.nameId.alias.add({ namespace: "lunar.memory", alias: "latest", identityId: "i1" });
  expect(await planet.nameId.resolve({ namespace: "lunar.memory", name: "latest" })).toMatchObject({ id: "i1", name: "canonical" });
  expect(calls).toEqual([["create", "acme"], ["alias", "latest"]]);
});

test("memory ingestion embeds, resolves entities, writes graph evidence, and queries fused results", async () => {
  const nodes = new Map(); const edges = new Map(); const vectors = new Map(); const memories = new Map(); const evidence = [];
  const now = new Date();
  const graph = {
    createNode: async (input) => { const value = { id: input.id ?? `n${nodes.size}`, type: input.type, name: input.name, properties: input.properties ?? {}, createdAt: now, updatedAt: now }; nodes.set(value.id, value); return value; },
    getNode: async (id) => nodes.get(id) ?? null,
    updateNode: async () => null,
    deleteNode: async (id) => nodes.delete(id),
    createEdge: async (input) => { const value = { id: input.id, sourceId: input.from, targetId: input.to, relation: input.relation, properties: input.properties ?? {}, createdAt: now, updatedAt: now }; edges.set(value.id, value); return value; },
    getEdge: async (id) => edges.get(id) ?? null,
    deleteEdge: async (id) => edges.delete(id),
    neighbors: async ({ nodeId }) => [...edges.values()].filter((edge) => edge.sourceId === nodeId),
    traverse: async ({ startIds }) => ({ nodes: startIds.map((id) => nodes.get(id)).filter(Boolean), edges: [...edges.values()], depthByNode: Object.fromEntries(startIds.map((id) => [id, 0])) }),
    searchNodes: async ({ query }) => [...nodes.values()].filter((node) => node.name.toLowerCase().includes(query.toLowerCase())),
  };
  const identityStore = {
    create: async ({ namespace, name }) => ({ id: `identity-${name}`, namespace, name, metadata: {}, createdAt: now }),
    get: async () => null,
    resolve: async () => null,
    addAlias: async () => {},
    bind: async () => { throw new Error("unused"); },
    listBindings: async () => [],
  };
  const planet = new Planet({
    providers: [{ id: "db", graph, identities: identityStore,
      memories: {
        add: async (input) => { const value = { ...input, type: input.type ?? "fact", metadata: input.metadata ?? {}, createdAt: now, updatedAt: now }; memories.set(input.id, value); return value; },
        get: async (id) => memories.get(id) ?? null,
        search: async ({ query, agentId }) => [...memories.values()].filter((memory) => (!query || memory.content.toLowerCase().includes(query.toLowerCase())) && (!agentId || memory.agentId === agentId)),
        delete: async (id) => memories.delete(id),
      },
      vector: { upsert: async (record) => vectors.set(`${record.namespace}:${record.id}`, record), delete: async () => {}, search: async ({ namespace }) => [...vectors.values()].filter((record) => record.namespace === namespace).map((record) => ({ id: record.id, namespace, score: 0.9, metadata: record.metadata })) },
      evidence: { add: async (input) => { const row = { ...input, id: input.id, createdAt: now, metadata: input.metadata ?? {} }; evidence.push(row); return row; }, list: async ({ edgeId, edgeIds, sourceId }) => evidence.filter((row) => (!edgeId || row.edgeId === edgeId) && (!edgeIds || edgeIds.includes(row.edgeId)) && (!sourceId || row.sourceId === sourceId)) },
    }], routing: { graph: "db", identities: "db", memories: "db", vector: "db", evidence: "db" }, embeddings: { embed: async () => [0.1, 0.2] },
    extractor: { extract: async () => [{ name: "Attention", type: "METHOD", aliases: ["Attn"] }] },
  });
  const record = await planet.memory.add({ agentId: "research-agent", content: "Attention improved forecasting performance", source: { type: "experiment", id: "exp-42" } });
  const duplicate = await planet.memory.add({ agentId: "research-agent", content: "Attention improved forecasting performance", source: { type: "experiment", id: "exp-42" } });
  expect(duplicate.id).toBe(record.id);
  expect(record.id).toBeDefined();
  expect(nodes.get(record.id).type).toBe("memory");
  expect([...nodes.values()].some((node) => node.name === "Attention")).toBe(true);
  expect([...edges.values()].some((edge) => edge.relation === "MENTIONS")).toBe(true);
  expect(evidence[0].sourceId).toBe(record.id);
  expect(evidence).toHaveLength(1);
  expect(edges.size).toBe(1);
  expect(vectors.has(`memory:${record.id}`)).toBe(true);
  const result = await planet.query({ text: "Attention", search: { keyword: true, vector: true, graph: false }, includeEvidence: true });
  expect(result.some((item) => item.node.id === record.id && item.sources.some((source) => source.id === record.id))).toBe(true);
});

test("supporting and contradictory evidence coexist and deterministically update confidence/status", async () => {
  const now = new Date(); const edge = { id: "e", sourceId: "a", targetId: "b", relation: "CAUSES", properties: {}, confidence: 0.5, status: "candidate", createdAt: now, updatedAt: now }; const records = [];
  const graph = { createNode: async () => null, getNode: async () => null, updateNode: async () => null, deleteNode: async () => false, createEdge: async () => edge, getEdge: async () => edge, updateEdge: async (_id, input) => Object.assign(edge, input), deleteEdge: async () => false, neighbors: async () => [], traverse: async () => ({ nodes: [], edges: [], depthByNode: {} }), searchNodes: async () => [] };
  const planet = new Planet({ graph, evidence: {
    add: async (input) => { const result = { ...input, id: `ev-${records.length}`, createdAt: now, metadata: input.metadata ?? {} }; records.push(result); return result; },
    list: async ({ edgeId }) => records.filter((item) => item.edgeId === edgeId),
  } });
  await planet.evidence.add({ edgeId: "e", sourceId: "source-1", sourceType: "experiment", extractor: "test", confidence: 0.8, strength: 0.5, direction: "support" });
  expect(edge.confidence).toBeCloseTo(0.7);
  await planet.evidence.add({ edgeId: "e", sourceId: "source-2", sourceType: "experiment", extractor: "test", confidence: 0.8, strength: 0.5, direction: "contradict" });
  expect(edge.confidence).toBeCloseTo(0.42);
  expect(edge.status).toBe("disputed");
  expect(records.map((record) => record.direction)).toEqual(["support", "contradict"]);
});

test("document ingestion chunks HTML deterministically, tracks checkpoints, and reuses document/chunk identities", async () => {
  const documents = new Map(); const chunks = new Map(); const jobs = new Map(); const vectorWrites = []; let failFirstVectorWrite = true;
  const now = new Date();
  const planet = new Planet({
    ingestionJobs: {
      create: async (input) => { const job = { id: input.id, kind: input.kind, input: input.input, status: "queued", checkpoint: "queued", attempts: 0, maxAttempts: input.maxAttempts ?? 5, nextAttemptAt: now, createdAt: now, updatedAt: now }; jobs.set(job.id, job); return job; },
      get: async (id) => jobs.get(id) ?? null,
      update: async (input) => { const job = jobs.get(input.id); Object.assign(job, input, { updatedAt: now }); return job; },
      claimDue: async () => { const job = [...jobs.values()].find((item) => item.status === "retry_wait"); if (!job) return []; job.attempts += 1; job.status = "processing"; return [job]; },
    },
    documents: {
      create: async (input) => { const value = { ...input, metadata: input.metadata ?? {}, createdAt: now, updatedAt: now }; documents.set(input.id, value); return value; },
      get: async (id) => documents.get(id) ?? null,
    },
    chunks: {
      create: async (input) => { const value = { ...input, metadata: input.metadata ?? {}, createdAt: now, updatedAt: now }; chunks.set(input.id, value); return value; },
      get: async (id) => chunks.get(id) ?? null,
      list: async ({ documentId }) => [...chunks.values()].filter((chunk) => chunk.documentId === documentId),
      search: async () => [],
      deleteExcept: async ({ keepIds }) => { for (const id of chunks.keys()) if (!keepIds.includes(id)) chunks.delete(id); return 0; },
    },
    vector: { upsert: async (record) => { if (failFirstVectorWrite) { failFirstVectorWrite = false; throw new Error("temporary vector outage"); } vectorWrites.push(record); }, search: async () => [], delete: async () => {} },
    embeddings: { model: "test-embed", embed: async () => [0.1, 0.2] },
  });
  const data = new TextEncoder().encode(`<html><body><p>${"A useful deterministic document chunk. ".repeat(8)}</p></body></html>`);
  let failedJobId;
  try { await planet.document.ingest({ title: "Paper", contentType: "text/html", data, chunkSize: 64, overlap: 8 }); }
  catch (error) { failedJobId = error.ingestionJobId; }
  expect(failedJobId).toBeDefined();
  expect(jobs.get(failedJobId).status).toBe("retry_wait");
  const retried = await planet.ingestion.runDue({ limit: 1 });
  expect(retried).toMatchObject({ claimed: 1, results: [{ id: failedJobId, status: "succeeded" }] });
  const first = await planet.document.ingest({ title: "Paper", contentType: "text/html", data, chunkSize: 64, overlap: 8 });
  const second = await planet.document.ingest({ title: "Paper", contentType: "text/html", data, chunkSize: 64, overlap: 8 });
  expect(first.document.id).toBe(second.document.id);
  expect(first.jobId).toBeDefined();
  expect(jobs.get(failedJobId).attempts).toBe(2);
  expect(jobs.get(first.jobId).status).toBe("succeeded");
  expect(jobs.get(first.jobId).checkpoint).toBe("completed");
  expect(jobs.get(first.jobId).attempts).toBe(1);
  expect(first.chunks.map((chunk) => chunk.id)).toEqual(second.chunks.map((chunk) => chunk.id));
  expect(first.chunks[0].text).not.toContain("<p>");
  expect(first.chunks.every((chunk) => chunk.startOffset <= chunk.endOffset)).toBe(true);
  expect(vectorWrites).toHaveLength(first.chunks.length * 3);
});

test("entity resolution normalizes organization variants and stores the variant as an alias", async () => {
  const now = new Date(); const identities = new Map(); const aliases = new Map(); const nodes = new Map(); const edges = new Map(); const memories = new Map();
  const graph = {
    createNode: async (input) => { const value = { id: input.id, type: input.type, name: input.name, properties: input.properties ?? {}, createdAt: now, updatedAt: now }; nodes.set(value.id, value); return value; },
    getNode: async (id) => nodes.get(id) ?? null, updateNode: async () => null, deleteNode: async () => false,
    createEdge: async (input) => { const value = { id: input.id, sourceId: input.from, targetId: input.to, relation: input.relation, properties: {}, createdAt: now, updatedAt: now }; edges.set(value.id, value); return value; },
    getEdge: async (id) => edges.get(id) ?? null, deleteEdge: async (id) => edges.delete(id), updateEdge: async () => null,
    neighbors: async ({ nodeId }) => [...edges.values()].filter((edge) => edge.sourceId === nodeId),
    traverse: async () => ({ nodes: [], edges: [], depthByNode: {} }), searchNodes: async () => [],
  };
  const identityStore = {
    create: async ({ namespace, name }) => { const value = { id: `entity-${identities.size}`, namespace, name, metadata: {}, createdAt: now }; identities.set(value.id, value); return value; },
    get: async () => null,
    resolve: async ({ namespace, name }) => [...identities.values()].find((item) => item.namespace === namespace && (item.name === name || aliases.get(`${namespace}:${name}`) === item.id)) ?? null,
    list: async ({ namespace }) => [...identities.values()].filter((item) => item.namespace === namespace),
    addAlias: async ({ namespace, alias, identityId }) => { aliases.set(`${namespace}:${alias}`, identityId); }, bind: async () => null, listBindings: async () => [],
  };
  const planet = new Planet({
    providers: [{ id: "db", graph, identities: identityStore,
      memories: { add: async (input) => { const record = { ...input, type: input.type ?? "fact", metadata: {}, createdAt: now, updatedAt: now }; memories.set(record.id, record); return record; }, get: async (id) => memories.get(id) ?? null, search: async () => [], delete: async () => true },
      vector: { upsert: async () => {}, search: async () => [], delete: async () => {} },
    }], routing: { graph: "db", identities: "db", memories: "db", vector: "db" }, embeddings: { embed: async () => [0.1] },
    extractor: { extract: async ({ text }) => [{ name: text.includes("revision") ? "Open AI" : "OpenAI", type: "ORG" }] },
  });
  await planet.memory.add({ id: "mem-1", agentId: "agent", content: "OpenAI research" });
  await planet.memory.add({ id: "mem-2", agentId: "agent", content: "revision Open AI research" });
  expect(identities.size).toBe(1);
  expect(aliases.get("entity:ORG:Open AI")).toBe("entity-0");
  expect([...nodes.values()].filter((node) => node.type === "ORG")).toHaveLength(1);
});
