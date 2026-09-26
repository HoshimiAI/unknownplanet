import { Elysia, t } from "elysia";
import { Pool } from "pg";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { createPostgresProvider } from "@unknown-planet/postgres";
import { JsonHttpEntityExtractor, OpenAICompatibleEmbeddingProvider, Planet, PlanetError, PlanetNotFoundError, startHttpRequest } from "@unknown-planet/sdk";
import type { JsonObject } from "@unknown-planet/sdk";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://unknownplanet:unknownplanet@localhost:5432/unknownplanet";
const port = Number(process.env.PORT ?? 3000);
const embeddingDimensions = Number(process.env.EMBEDDING_DIMENSIONS ?? 8);
const tenantId = process.env.TENANT_ID ?? "local-dev";
const workspaceId = process.env.WORKSPACE_ID;
const planetSchema = process.env.PLANET_SCHEMA ?? "public";
const embeddingModel = process.env.OPENAI_API_KEY ? (process.env.EMBEDDING_MODEL ?? "text-embedding-3-small") : "demo-character-hash";
const telemetryEnabled = process.env.OTEL_SDK_DISABLED !== "true" && (process.env.OTEL_ENABLED === "true" || Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT || process.env.OTEL_TRACES_EXPORTER || process.env.OTEL_METRICS_EXPORTER));
const telemetrySdk = telemetryEnabled ? new NodeSDK({ serviceName: process.env.OTEL_SERVICE_NAME ?? "unknown-planet-elysia" }) : undefined;
telemetrySdk?.start();
const pool = new Pool({ connectionString: databaseUrl });

function demoEmbedding(text: string, dimensions = embeddingDimensions): number[] {
  const vector = Array.from({ length: dimensions }, () => 0);
  for (let index = 0; index < text.length; index += 1) {
    vector[index % dimensions]! += (text.charCodeAt(index) % 31) - 15;
  }
  const magnitude = Math.hypot(...vector) || 1;
  return vector.map((component) => component / magnitude);
}

const planet = new Planet({
  providers: [createPostgresProvider({ database: pool, schema: planetSchema, vectorCollections: { node: { dimensions: embeddingDimensions, model: embeddingModel }, memory: { dimensions: embeddingDimensions, model: embeddingModel }, "document-chunk": { dimensions: embeddingDimensions, model: embeddingModel } } })],
  scope: { tenantId, ...(workspaceId ? { workspaceId } : {}) },
  routing: {
    graph: "postgres",
    vector: "postgres",
    documents: "postgres",
    chunks: "postgres",
    evidence: "postgres",
    memories: "postgres",
    identities: "postgres",
    sql: "postgres",
  },
  // Deterministic local embeddings keep smoke tests self-contained. Production requires provider credentials.
  embeddings: process.env.OPENAI_API_KEY
    ? new OpenAICompatibleEmbeddingProvider({ apiKey: process.env.OPENAI_API_KEY, model: embeddingModel, baseUrl: process.env.OPENAI_BASE_URL, dimensions: embeddingDimensions })
    : { model: embeddingModel, dimensions: embeddingDimensions, embed: async ({ text }) => demoEmbedding(text) },
  extractor: process.env.LLM_API_KEY && process.env.LLM_API_URL && process.env.LLM_MODEL
    ? new JsonHttpEntityExtractor({ apiKey: process.env.LLM_API_KEY, endpoint: process.env.LLM_API_URL, model: process.env.LLM_MODEL })
    : undefined,
});

type AuthScope = { tenantId: string; workspaceId?: string };
const apiKeys = process.env.API_KEYS ? JSON.parse(process.env.API_KEYS) as Record<string, AuthScope> : undefined;
if (process.env.NODE_ENV === "production" && (!apiKeys || !Object.keys(apiKeys).length)) throw new Error("Production requires API_KEYS as a JSON object mapping bearer tokens to tenant scopes.");
if (process.env.NODE_ENV === "production" && !process.env.OPENAI_API_KEY) throw new Error("Production requires OPENAI_API_KEY and a configured embedding model.");
if (process.env.NODE_ENV === "production" && !(process.env.LLM_API_KEY && process.env.LLM_API_URL && process.env.LLM_MODEL)) throw new Error("Production requires LLM_API_KEY, LLM_API_URL, and LLM_MODEL for entity extraction.");
function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function requestPlanet(request: Request, parent?: ReturnType<typeof startHttpRequest>["spanContext"]): Planet {
  if (!apiKeys) return planet.withScope({ tenantId, ...(workspaceId ? { workspaceId } : {}) }, parent);
  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const match = Object.entries(apiKeys).find(([key]) => safeEqual(key, token));
  if (!match) throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
  const scope = match[1];
  if (!scope || typeof scope.tenantId !== "string" || !scope.tenantId.trim()) throw new Error("API key has an invalid tenant scope.");
  return planet.withScope(scope, parent);
}

const json = (value: Record<string, unknown> | undefined): JsonObject => value as JsonObject ?? {};
const toDate = (value: string | undefined): Date | undefined => {
  if (value === undefined) return undefined;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw Object.assign(new Error("Date values must be valid ISO timestamps."), { statusCode: 400 });
  return date;
};
const assertEmbeddingDimensions = (embedding: number[]) => {
  if (embedding.length !== embeddingDimensions) {
    throw new Error(`Embeddings must contain ${embeddingDimensions} dimensions.`);
  }
};

const requestTelemetry = new WeakMap<Request, ReturnType<typeof startHttpRequest>>();
const completedRequests = new WeakSet<Request>();
const app = new Elysia({ name: "unknown-planet-live", prefix: "/v1" })
  .onRequest(({ request, set }) => {
    const requestId = request.headers.get("x-request-id") || randomUUID();
    set.headers["x-request-id"] = requestId;
    const telemetry = startHttpRequest({ method: request.method, requestId });
    requestTelemetry.set(request, telemetry);
    if (telemetry.traceId && telemetry.spanId) set.headers.traceparent = `00-${telemetry.traceId}-${telemetry.spanId}-01`;
  })
  .derive(({ request }) => ({ client: requestPlanet(request, requestTelemetry.get(request)?.spanContext) }))
  .onError(({ code, error, request, set }) => {
    const status = error instanceof PlanetError ? error.statusCode : (error as Error & { statusCode?: number })?.statusCode ?? (code === "VALIDATION" || (error instanceof Error && (error.message.startsWith("Embeddings must contain ") || error.message.includes("must be between"))) ? 400 : 500);
    set.status = status;
    const telemetry = requestTelemetry.get(request);
    if (telemetry && !completedRequests.has(request)) { telemetry.finish(status, error); completedRequests.add(request); }
    console.error(JSON.stringify({ event: "request.error", requestId: set.headers["x-request-id"], traceId: telemetry?.traceId, spanId: telemetry?.spanId, method: request.method, path: new URL(request.url).pathname, status, error: error instanceof Error ? error.name : "UnknownError" }));
    return { error: status >= 500 ? "Request failed. See requestId for support." : error instanceof Error ? error.message : "Request failed", code: error instanceof PlanetError ? error.code : status === 401 ? "unauthorized" : status === 400 ? "invalid_request" : status === 404 ? "not_found" : status === 409 ? "conflict" : status === 503 ? "capability_unavailable" : "internal_error", requestId: set.headers["x-request-id"], ...(error && typeof error === "object" && "ingestionJobId" in error ? { jobId: (error as Error & { ingestionJobId: string }).ingestionJobId } : {}) };
  })
  .onAfterHandle(({ request, set }) => {
    const telemetry = requestTelemetry.get(request);
    if (telemetry && !completedRequests.has(request)) { telemetry.finish(Number(set.status) || 200); completedRequests.add(request); }
    console.log(JSON.stringify({ event: "request.complete", requestId: set.headers["x-request-id"], traceId: telemetry?.traceId, spanId: telemetry?.spanId, method: request.method, path: new URL(request.url).pathname, status: set.status }));
  })
  .get("/health", async ({ client }) => {
    await client.sql.query({ text: "SELECT 1" });
    return { ok: true, provider: "postgres" };
  })
  .get("/openapi.json", () => ({
    openapi: "3.1.0", info: { title: "Unknown Planet API", version: "1.0.0" },
    components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } } },
    security: [{ bearerAuth: [] }],
    paths: Object.fromEntries(Object.entries({
      "/health": { get: { summary: "Check database connectivity", responses: { "200": { description: "Healthy" } } } },
      "/memory": { get: { summary: "Search memories", parameters: [{ in: "query", name: "text", schema: { type: "string" } }, { in: "query", name: "agentId", schema: { type: "string" } }], responses: { "200": { description: "Matching scoped memories" } } } },
      "/memory/page": { get: { summary: "Search memories with stable cursor pagination", parameters: [{ in: "query", name: "cursor", schema: { type: "string" } }, { in: "query", name: "limit", schema: { type: "integer" } }], responses: { "200": { description: "Memory items and next cursor" } } } },
      "/documents/{documentId}/chunks/page": { get: { summary: "List document chunks with stable cursor pagination", parameters: [{ in: "path", name: "documentId", required: true, schema: { type: "string" } }, { in: "query", name: "cursor", schema: { type: "string" } }, { in: "query", name: "limit", schema: { type: "integer" } }], responses: { "200": { description: "Chunk items and next cursor" } } } },
      "/identities/{identityId}/bindings/page": { get: { summary: "List identity bindings with cursor pagination", parameters: [{ in: "path", name: "identityId", required: true, schema: { type: "string" } }, { in: "query", name: "cursor", schema: { type: "string" } }], responses: { "200": { description: "Binding items and next cursor" } } } },
      "/evidence/{edgeId}/page": { get: { summary: "List edge evidence with cursor pagination", parameters: [{ in: "path", name: "edgeId", required: true, schema: { type: "string" } }, { in: "query", name: "cursor", schema: { type: "string" } }], responses: { "200": { description: "Evidence items and next cursor" } } } },
      "/graph/search/page": { post: { summary: "Browse ranked graph results", responses: { "200": { description: "Node results and next cursor" } } } },
      "/query/page": { post: { summary: "Browse ranked knowledge results", responses: { "200": { description: "Ranked results and next cursor" } } } },
      "/memory/{id}": { get: { summary: "Get a memory", responses: { "200": { description: "Memory record" }, "404": { description: "Not found" } } }, delete: { summary: "Delete a memory", responses: { "204": { description: "Deleted" } } } },
      "/query": { post: { summary: "Search keyword, vector, graph, and document chunks", requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["text"], properties: { text: { type: "string" }, search: { type: "object" }, filters: { type: "object" }, expand: { type: "object" }, includeEvidence: { type: "boolean" }, limit: { type: "integer" } } } } } }, responses: { "200": { description: "Ranked results with source provenance" } } } },
      "/ingest": { post: { summary: "Parse, chunk, embed, and index a document", responses: { "200": { description: "Stored document and chunks" } } } },
      "/ingestion-jobs/{id}": { get: { summary: "Get the durable state of a document ingestion", responses: { "200": { description: "Ingestion job" }, "404": { description: "Not found" } } } },
      "/ingestion-jobs/run-due": { post: { summary: "Claim and process due ingestion retries", responses: { "200": { description: "Processed jobs" } } } },
      "/documents": { post: { summary: "Create a document source", responses: { "200": { description: "Created document" } } } },
      "/nodes": { post: { summary: "Create a graph node", responses: { "200": { description: "Created node" } } } },
      "/nodes/{nodeId}/merge": { post: { summary: "Merge a duplicate graph node into a canonical node", responses: { "200": { description: "Merge record" }, "409": { description: "Invalid merge" } } } },
      "/edges": { post: { summary: "Create a temporal graph edge", responses: { "200": { description: "Created edge" } } } },
      "/evidence": { post: { summary: "Attach sourced evidence to an edge", responses: { "200": { description: "Created evidence" } } } },
    }).map(([path, methods]) => [`/v1${path}`, methods])),
  }))
  .post("/documents", async ({ body, client }) => client.document.create({
    title: body.title,
    contentUri: body.contentUri,
    externalId: body.externalId,
    metadata: json(body.metadata),
  }), {
    body: t.Object({ title: t.String(), contentUri: t.String(), externalId: t.Optional(t.String()), metadata: t.Optional(t.Record(t.String(), t.Any())) }),
  })
  .post("/documents/:documentId/chunks", ({ params, body, client }) => client.document.chunk.create({
    documentId: params.documentId,
    text: body.text,
    contentUri: body.contentUri,
    startOffset: body.startOffset,
    endOffset: body.endOffset,
    metadata: json(body.metadata),
  }), {
    params: t.Object({ documentId: t.String() }),
    body: t.Object({ text: t.Optional(t.String()), contentUri: t.Optional(t.String()), startOffset: t.Optional(t.Number({ minimum: 0 })), endOffset: t.Optional(t.Number({ minimum: 0 })), metadata: t.Optional(t.Record(t.String(), t.Any())) }),
  })
  .get("/documents/:documentId/chunks", ({ params, query, client }) => client.document.chunk.list({ documentId: params.documentId, limit: query.limit ? Number(query.limit) : undefined }), {
    params: t.Object({ documentId: t.String() }),
    query: t.Object({ limit: t.Optional(t.String()) }),
  })
  .get("/documents/:documentId/chunks/page", ({ params, query, client }) => client.document.chunk.listPage({ documentId: params.documentId, limit: query.limit ? Number(query.limit) : undefined, cursor: query.cursor }), {
    params: t.Object({ documentId: t.String() }), query: t.Object({ limit: t.Optional(t.String()), cursor: t.Optional(t.String()) }),
  })
  .post("/identities", ({ body, client }) => client.nameId.create({ namespace: body.namespace, name: body.name, metadata: json(body.metadata) }), {
    body: t.Object({ namespace: t.String({ minLength: 1 }), name: t.String({ minLength: 1 }), metadata: t.Optional(t.Record(t.String(), t.Any())) }),
  })
  .get("/identities/resolve", ({ query, client }) => client.nameId.resolve({ namespace: query.namespace, name: query.name }), {
    query: t.Object({ namespace: t.String(), name: t.String() }),
  })
  .post("/identities/aliases", async ({ body, set, client }) => {
    await client.nameId.alias.add({ namespace: body.namespace, alias: body.alias, identityId: body.identityId });
    set.status = 204;
    return null;
  }, {
    body: t.Object({ namespace: t.String({ minLength: 1 }), alias: t.String({ minLength: 1 }), identityId: t.String() }),
  })
  .post("/identities/:identityId/bindings", ({ params, body, client }) => client.nameId.bind({
    identityId: params.identityId,
    providerId: body.providerId,
    resourceType: body.resourceType,
    resourceId: body.resourceId,
    metadata: json(body.metadata),
  }), {
    params: t.Object({ identityId: t.String() }),
    body: t.Object({ providerId: t.String({ minLength: 1 }), resourceType: t.String({ minLength: 1 }), resourceId: t.String({ minLength: 1 }), metadata: t.Optional(t.Record(t.String(), t.Any())) }),
  })
  .get("/identities/:identityId/bindings", ({ params, query, client }) => client.nameId.bindings.list({ identityId: params.identityId, limit: query.limit ? Number(query.limit) : undefined }), {
    params: t.Object({ identityId: t.String() }),
    query: t.Object({ limit: t.Optional(t.String()) }),
  })
  .get("/identities/:identityId/bindings/page", ({ params, query, client }) => client.nameId.bindings.listPage({ identityId: params.identityId, limit: query.limit ? Number(query.limit) : undefined, cursor: query.cursor }), {
    params: t.Object({ identityId: t.String() }), query: t.Object({ limit: t.Optional(t.String()), cursor: t.Optional(t.String()) }),
  })
  .post("/nodes", async ({ body, client }) => {
    if (body.embedding) assertEmbeddingDimensions(body.embedding);
    const node = await client.graph.node.create({ type: body.type, name: body.name, properties: json(body.properties), embedding: body.embedding });
    if (body.embedding) await client.vector.upsert({ id: node.id, namespace: "node", embedding: body.embedding, metadata: { type: node.type, name: node.name } });
    return node;
  }, {
    body: t.Object({ type: t.String(), name: t.String(), properties: t.Optional(t.Record(t.String(), t.Any())), embedding: t.Optional(t.Array(t.Number())) }),
  })
  .post("/nodes/:nodeId/merge", ({ params, body, client }) => client.graph.node.merge({ sourceId: params.nodeId, targetId: body.targetId }), {
    params: t.Object({ nodeId: t.String() }), body: t.Object({ targetId: t.String({ minLength: 1 }) }),
  })
  .post("/vectors", async ({ body, client }) => {
    assertEmbeddingDimensions(body.embedding);
    await client.vector.upsert({ id: body.id, namespace: body.namespace, embedding: body.embedding, metadata: json(body.metadata) });
    return { ok: true };
  }, {
    body: t.Object({ id: t.String(), namespace: t.String(), embedding: t.Array(t.Number()), metadata: t.Optional(t.Record(t.String(), t.Any())) }),
  })
  .post("/edges", async ({ body, client }) => client.graph.edge.create({
    from: body.from,
    to: body.to,
    relation: body.relation,
    confidence: body.confidence,
    validFrom: toDate(body.validFrom),
    validTo: toDate(body.validTo),
    status: body.status,
    properties: json(body.properties),
  }), {
    body: t.Object({ from: t.String(), to: t.String(), relation: t.String(), confidence: t.Optional(t.Number({ minimum: 0, maximum: 1 })), validFrom: t.Optional(t.String()), validTo: t.Optional(t.String()), status: t.Optional(t.Union([t.Literal("candidate"), t.Literal("canonical"), t.Literal("disputed"), t.Literal("rejected"), t.Literal("deprecated")])), properties: t.Optional(t.Record(t.String(), t.Any())) }),
  })
  .post("/evidence", async ({ body, client }) => client.evidence.add({
    edgeId: body.edgeId,
    documentId: body.documentId,
    chunkId: body.chunkId,
    sourceType: body.sourceType,
    extractor: body.extractor,
    confidence: body.confidence,
    direction: body.direction,
    strength: body.strength,
    metadata: json(body.metadata),
  }), {
    body: t.Object({ edgeId: t.String(), documentId: t.Optional(t.String()), sourceId: t.Optional(t.String()), extractor: t.String(), chunkId: t.Optional(t.String()), sourceType: t.Optional(t.String()), confidence: t.Optional(t.Number({ minimum: 0, maximum: 1 })), direction: t.Optional(t.Union([t.Literal("support"), t.Literal("contradict"), t.Literal("neutral")])), strength: t.Optional(t.Number({ minimum: 0, maximum: 1 })), metadata: t.Optional(t.Record(t.String(), t.Any())) }),
  })
  .get("/evidence/:edgeId", ({ params, client }) => client.evidence.list({ edgeId: params.edgeId }), {
    params: t.Object({ edgeId: t.String() }),
  })
  .get("/evidence/:edgeId/page", ({ params, query, client }) => client.evidence.listPage({ edgeId: params.edgeId, limit: query.limit ? Number(query.limit) : undefined, cursor: query.cursor }), {
    params: t.Object({ edgeId: t.String() }), query: t.Object({ limit: t.Optional(t.String()), cursor: t.Optional(t.String()) }),
  })
  .post("/graph/search", ({ body, client }) => client.graph.search({
    query: body.query,
    semantic: body.semantic,
    graph: { depth: body.depth ?? 0 },
    limit: body.limit,
  }), {
    body: t.Object({ query: t.String(), semantic: t.Optional(t.Boolean()), depth: t.Optional(t.Number({ minimum: 0, maximum: 8 })), limit: t.Optional(t.Number({ minimum: 1, maximum: 100 })) }),
  })
  .post("/graph/search/page", ({ body, client }) => client.graph.searchPage({ query: body.query, semantic: body.semantic, graph: { depth: body.depth ?? 0 }, limit: body.limit, cursor: body.cursor }), {
    body: t.Object({ query: t.String(), semantic: t.Optional(t.Boolean()), depth: t.Optional(t.Number({ minimum: 0, maximum: 8 })), limit: t.Optional(t.Number({ minimum: 1, maximum: 100 })), cursor: t.Optional(t.String()) }),
  })
  .post("/memory", async ({ body, client }) => client.memory.add({
    agentId: body.agentId, content: body.content, type: body.type, userId: body.userId, sessionId: body.sessionId,
    importance: body.importance, confidence: body.confidence, source: body.source, metadata: json(body.metadata),
  }), {
    body: t.Object({ agentId: t.String({ minLength: 1 }), content: t.String({ minLength: 1 }), type: t.Optional(t.Union([t.Literal("fact"), t.Literal("observation"), t.Literal("episode"), t.Literal("decision"), t.Literal("preference"), t.Literal("instruction"), t.Literal("summary")])), userId: t.Optional(t.String()), sessionId: t.Optional(t.String()), importance: t.Optional(t.Number({ minimum: 0, maximum: 1 })), confidence: t.Optional(t.Number({ minimum: 0, maximum: 1 })), source: t.Optional(t.Object({ type: t.String(), id: t.String(), documentId: t.Optional(t.String()), chunkId: t.Optional(t.String()) })), metadata: t.Optional(t.Record(t.String(), t.Any())) }),
  })
  .get("/memory/:id", async ({ params, client }) => { const result = await client.memory.get(params.id); if (!result) throw new PlanetNotFoundError(`Memory '${params.id}' was not found in this scope.`); return result; }, { params: t.Object({ id: t.String() }) })
  .get("/memory", ({ query, client }) => client.memory.search({ agentId: query.agentId, userId: query.userId, sessionId: query.sessionId, query: query.text, limit: query.limit ? Number(query.limit) : undefined }), {
    query: t.Object({ agentId: t.Optional(t.String()), userId: t.Optional(t.String()), sessionId: t.Optional(t.String()), text: t.Optional(t.String()), limit: t.Optional(t.String()) }),
  })
  .get("/memory/page", ({ query, client }) => client.memory.searchPage({ agentId: query.agentId, userId: query.userId, sessionId: query.sessionId, query: query.text, limit: query.limit ? Number(query.limit) : undefined, cursor: query.cursor }), {
    query: t.Object({ agentId: t.Optional(t.String()), userId: t.Optional(t.String()), sessionId: t.Optional(t.String()), text: t.Optional(t.String()), limit: t.Optional(t.String()), cursor: t.Optional(t.String()) }),
  })
  .delete("/memory/:id", async ({ params, client, set }) => { const deleted = await client.memory.delete(params.id); if (!deleted) throw new PlanetNotFoundError(`Memory '${params.id}' was not found in this scope.`); set.status = 204; return null; }, { params: t.Object({ id: t.String() }) })
  .post("/query", ({ body, client }) => client.query({ text: body.text, search: body.search, filters: body.filters, expand: body.expand, includeEvidence: body.includeEvidence, limit: body.limit, asOf: toDate(body.asOf) }), {
    body: t.Object({ text: t.String({ minLength: 1 }), search: t.Optional(t.Object({ keyword: t.Optional(t.Boolean()), vector: t.Optional(t.Boolean()), graph: t.Optional(t.Boolean()) })), filters: t.Optional(t.Object({ nodeType: t.Optional(t.String()), metadata: t.Optional(t.Record(t.String(), t.Any())), agentId: t.Optional(t.String()), documentId: t.Optional(t.String()) })), expand: t.Optional(t.Object({ relationDepth: t.Optional(t.Number({ minimum: 0, maximum: 8 })) })), includeEvidence: t.Optional(t.Boolean()), limit: t.Optional(t.Number({ minimum: 1, maximum: 100 })), asOf: t.Optional(t.String()) }),
  })
  .post("/query/page", ({ body, client }) => client.queryPage({ text: body.text, search: body.search, filters: body.filters, expand: body.expand, includeEvidence: body.includeEvidence, limit: body.limit, asOf: toDate(body.asOf), cursor: body.cursor }), {
    body: t.Object({ text: t.String({ minLength: 1 }), search: t.Optional(t.Object({ keyword: t.Optional(t.Boolean()), vector: t.Optional(t.Boolean()), graph: t.Optional(t.Boolean()) })), filters: t.Optional(t.Object({ nodeType: t.Optional(t.String()), metadata: t.Optional(t.Record(t.String(), t.Any())), agentId: t.Optional(t.String()), documentId: t.Optional(t.String()) })), expand: t.Optional(t.Object({ relationDepth: t.Optional(t.Number({ minimum: 0, maximum: 8 })) })), includeEvidence: t.Optional(t.Boolean()), limit: t.Optional(t.Number({ minimum: 1, maximum: 100 })), asOf: t.Optional(t.String()), cursor: t.Optional(t.String()) }),
  })
  .post("/ingest", ({ body, client }) => client.document.ingest({ title: body.title, contentType: body.contentType, data: new TextEncoder().encode(body.content), contentUri: body.contentUri, externalId: body.externalId, chunkSize: body.chunkSize, overlap: body.overlap, metadata: json(body.metadata) }), {
    body: t.Object({ title: t.String({ minLength: 1 }), contentType: t.String(), content: t.String({ minLength: 1 }), contentUri: t.Optional(t.String()), externalId: t.Optional(t.String()), chunkSize: t.Optional(t.Number({ minimum: 64 })), overlap: t.Optional(t.Number({ minimum: 0 })), metadata: t.Optional(t.Record(t.String(), t.Any())) }),
  })
  .get("/ingestion-jobs/:id", async ({ params, client }) => { const job = await client.ingestion.get(params.id); if (!job) throw new PlanetNotFoundError(`Ingestion job '${params.id}' was not found in this scope.`); return job; }, { params: t.Object({ id: t.String() }) })
  .post("/ingestion-jobs/run-due", ({ body, client }) => client.ingestion.runDue(body), { body: t.Object({ limit: t.Optional(t.Number({ minimum: 1, maximum: 100 })), leaseMs: t.Optional(t.Number({ minimum: 1000 })) }) })
  .listen(port);

console.log(`Unknown Planet live API listening on http://${app.server?.hostname ?? "localhost"}:${app.server?.port ?? port}`);

const shutdown = async () => {
  app.stop();
  await Promise.all([pool.end(), telemetrySdk?.shutdown()]);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
