import { Elysia, t } from "elysia";
import { Pool } from "pg";
import type { JsonObject } from "@unknown-planet/core";
import { createPostgresProvider } from "@unknown-planet/postgres";
import { Planet } from "@unknown-planet/sdk";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://unknownplanet:unknownplanet@localhost:5432/unknownplanet";
const port = Number(process.env.PORT ?? 3000);
const embeddingDimensions = Number(process.env.EMBEDDING_DIMENSIONS ?? 8);
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
  providers: [createPostgresProvider({ database: pool })],
  routing: {
    graph: "postgres",
    vector: "postgres",
    documents: "postgres",
    evidence: "postgres",
    sql: "postgres",
  },
  // This deterministic embedding is for local smoke tests only. Use a real embedding provider in production.
  embeddings: { embed: async ({ text }) => demoEmbedding(text) },
});

const json = (value: Record<string, unknown> | undefined): JsonObject => value as JsonObject ?? {};
const assertEmbeddingDimensions = (embedding: number[]) => {
  if (embedding.length !== embeddingDimensions) {
    throw new Error(`Embeddings must contain ${embeddingDimensions} dimensions.`);
  }
};

const app = new Elysia({ name: "unknown-planet-live" })
  .onError(({ code, error, set }) => {
    set.status = code === "VALIDATION" ? 400 : 500;
    return { error: error instanceof Error ? error.message : "Request failed" };
  })
  .get("/health", async () => {
    await planet.sql.query({ text: "SELECT 1" });
    return { ok: true, provider: "postgres" };
  })
  .post("/documents", async ({ body }) => planet.document.create({
    title: body.title,
    contentUri: body.contentUri,
    externalId: body.externalId,
    metadata: json(body.metadata),
  }), {
    body: t.Object({ title: t.String(), contentUri: t.String(), externalId: t.Optional(t.String()), metadata: t.Optional(t.Record(t.String(), t.Any())) }),
  })
  .post("/nodes", async ({ body }) => {
    if (body.embedding) assertEmbeddingDimensions(body.embedding);
    const node = await planet.graph.node.create({ type: body.type, name: body.name, properties: json(body.properties), embedding: body.embedding });
    if (body.embedding) await planet.vector.upsert({ id: node.id, namespace: "node", embedding: body.embedding, metadata: { type: node.type, name: node.name } });
    return node;
  }, {
    body: t.Object({ type: t.String(), name: t.String(), properties: t.Optional(t.Record(t.String(), t.Any())), embedding: t.Optional(t.Array(t.Number())) }),
  })
  .post("/vectors", async ({ body }) => {
    assertEmbeddingDimensions(body.embedding);
    await planet.vector.upsert({ id: body.id, namespace: body.namespace, embedding: body.embedding, metadata: json(body.metadata) });
    return { ok: true };
  }, {
    body: t.Object({ id: t.String(), namespace: t.String(), embedding: t.Array(t.Number()), metadata: t.Optional(t.Record(t.String(), t.Any())) }),
  })
  .post("/edges", async ({ body }) => planet.graph.edge.create({
    from: body.from,
    to: body.to,
    relation: body.relation,
    confidence: body.confidence,
    properties: json(body.properties),
  }), {
    body: t.Object({ from: t.String(), to: t.String(), relation: t.String(), confidence: t.Optional(t.Number({ minimum: 0, maximum: 1 })), properties: t.Optional(t.Record(t.String(), t.Any())) }),
  })
  .post("/evidence", async ({ body }) => planet.evidence.add({
    edgeId: body.edgeId,
    documentId: body.documentId,
    chunkId: body.chunkId,
    sourceType: body.sourceType,
    extractor: body.extractor,
    confidence: body.confidence,
    metadata: json(body.metadata),
  }), {
    body: t.Object({ edgeId: t.String(), documentId: t.String(), extractor: t.String(), chunkId: t.Optional(t.String()), sourceType: t.Optional(t.String()), confidence: t.Optional(t.Number({ minimum: 0, maximum: 1 })), metadata: t.Optional(t.Record(t.String(), t.Any())) }),
  })
  .get("/evidence/:edgeId", ({ params }) => planet.evidence.list({ edgeId: params.edgeId }), {
    params: t.Object({ edgeId: t.String() }),
  })
  .post("/graph/search", ({ body }) => planet.graph.search({
    query: body.query,
    semantic: body.semantic,
    graph: { depth: body.depth ?? 0 },
    limit: body.limit,
  }), {
    body: t.Object({ query: t.String(), semantic: t.Optional(t.Boolean()), depth: t.Optional(t.Number({ minimum: 0, maximum: 8 })), limit: t.Optional(t.Number({ minimum: 1, maximum: 100 })) }),
  })
  .listen(port);

console.log(`Unknown Planet live API listening on http://${app.server?.hostname ?? "localhost"}:${app.server?.port ?? port}`);

const shutdown = async () => {
  app.stop();
  await pool.end();
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
