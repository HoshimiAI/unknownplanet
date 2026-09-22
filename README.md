# Unknown Planet

An AI-native data-layer orchestrator for graph, vector, document, and evidence retrieval. It is not a database engine or ORM. Applications depend on one SDK while adapters route each data capability to the appropriate provider.

## Packages

- `@unknown-planet/core` — domain types and storage contracts; no PostgreSQL imports.
- `@unknown-planet/postgres` — PostgreSQL/pgvector adapters and SQL migration.
- `@unknown-planet/mongodb` — MongoDB graph/document/evidence adapters and Atlas Vector Search.
- `@unknown-planet/sdk` — the `Planet` client and deterministic hybrid retrieval pipeline.

## Commands

```sh
bun install
bun run build
bun run typecheck
bun run lint
bun run test
```

## Live Elysia smoke test

Start PostgreSQL with pgvector and the Unknown Planet migration:

```sh
docker compose up -d postgres
docker compose ps
bun run --cwd apps/elysia dev
```

The API listens on `http://localhost:3000`. It uses a deterministic demo embedding only to exercise vector retrieval locally; configure a real embedding provider before production use.

```sh
curl http://localhost:3000/health

curl -X POST http://localhost:3000/nodes \
  -H 'content-type: application/json' \
  -d '{"type":"method","name":"Transformer","embedding":[0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8]}'
```

Compose initializes a new Docker volume with `001_initial.sql`. To reinitialize a local test database after changing the migration, run `docker compose down -v` and then start it again; this deletes local Compose data.

Run `packages/postgres/migrations/001_initial.sql` on a PostgreSQL database with the pgvector extension, then register and route providers in the SDK:

```ts
const planet = new Planet({
  providers: [
    createPostgresProvider({ database: pool }),
    { id: "qdrant", vector: new QdrantAdapter(/* ... */) },
    { id: "r2", blobs: new R2BlobStorageAdapter(/* ... */) },
  ],
  routing: {
    graph: "postgres", documents: "postgres", evidence: "postgres",
    vector: "qdrant", blobs: "r2",
  },
  embeddings: myEmbeddingProvider,
})
```

`planet.graph.search({ query, semantic: true, graph: { depth: 2 } })` runs embedding → vector candidates → graph expansion → evidence lookup → deterministic ranking. Vector records for graph nodes use the `node` namespace. Source bytes stay out of PostgreSQL; documents retain a URI and can be backed by any `BlobStorageAdapter`.

Adapters are capability-specific rather than all-or-nothing: future `QdrantAdapter`, `LanceDBAdapter`, `SupabaseAdapter`, or S3/R2 adapters only implement the relevant core contract. Unknown Planet does not synchronize or replicate providers automatically; that policy remains explicit in the application.

## Relational and NoSQL storage

Use the relational provider when PostgreSQL foreign keys and pgvector are the source of truth:

```ts
createPostgresProvider({ database: pool })
```

Use the MongoDB provider for document-oriented storage. It validates graph and evidence references in the adapter, explicitly deletes incident edges/evidence when deleting a node, and uses an Atlas Vector Search index for semantic search:

```ts
createMongoProvider({
  database: mongoClient.db("unknownplanet"),
  vectorIndex: "unknownplanet_vectors",
})
```

Both providers implement the same core contracts, so applications keep calling `planet.graph`, `planet.document`, `planet.evidence`, and `planet.vector`. They can be used independently or routed by capability; data synchronization between providers is intentionally an application policy.

## Normal relational tables with SQL

The PostgreSQL provider also exposes parameterized SQL for ordinary application tables, joins, and reports. Route it explicitly, and bind values through `values` rather than string interpolation:

```ts
const planet = new Planet({
  providers: [createPostgresProvider({ database: pool })],
  routing: { sql: "postgres" },
})

const project = await planet.sql.query<{ id: string; name: string }>({
  text: "INSERT INTO projects (id, name) VALUES ($1, $2) RETURNING id, name",
  values: [crypto.randomUUID(), "Unknown Planet"],
})

const memberships = await planet.sql.query<{ project_name: string; user_email: string }>({
  text: `SELECT p.name AS project_name, u.email AS user_email
         FROM projects p JOIN memberships m ON m.project_id = p.id
         JOIN users u ON u.id = m.user_id
         WHERE p.id = $1`,
  values: [project.rows[0].id],
})
```

`planet.sql` is available only when the routed provider implements `SqlStore`; MongoDB providers intentionally do not expose SQL.

`planet.sql.transaction()` is available when the routed provider supports transactions (the PostgreSQL provider does). The callback receives a parameterized transaction client:

```ts
await planet.sql.transaction(async (sql) => {
  await sql.query({ text: "INSERT INTO audit_log (id, action) VALUES ($1, $2)", values: [crypto.randomUUID(), "node-created"] })
})
```

## Flexible extensions

Providers may expose any application- or package-defined capability without requiring a new Unknown Planet release. Route it by name and retrieve it with `planet.extension()`:

```ts
const planet = new Planet({
  providers: [{
    id: "redis",
    extensions: {
      cache: new RedisCacheAdapter(redisClient),
      queue: new BullMQAdapter(queue),
    },
  }],
  routing: { extensions: { cache: "redis", queue: "redis" } },
})

const cache = planet.extension<RedisCacheAdapter>("cache")
await cache.set("node:123", node)
```

Core capabilities stay typed, while extensions make the library open to custom databases, caches, queues, search engines, and internal adapters.

Use `definePlanetExtension()` when publishing an extension library so consumers retain its type:

```ts
export const cacheExtension = definePlanetExtension<CacheAdapter>("cache")
const cache = planet.extension(cacheExtension)
```

## Lunar ADK custom provider

Lunar ADK integrates through a Lunar-owned custom provider package, not a dependency from Planet core. The provider consumes a configured `Planet` instance and implements Lunar's `StorageBundle` and `MemoryProvider` contracts using PostgreSQL SQL transactions and Planet vectors.

The integration requires a PostgreSQL-routed `planet.sql` capability because Lunar run/session persistence relies on atomic transactions. It stores Lunar runs, sessions, workflows, and memories in a dedicated `lunar` schema; source graph/document data stays in the existing Planet domains.

The provider's additive migration and its rollback guidance are documented in [Lunar ADK provider notes](docs/lunar-adk-provider.md). Cache and artifacts remain Lunar-owned future providers: a Lunar cache provider can consume a typed Planet extension without either core framework changing.

## Customization

Use `selectProvider` for environment- or tenant-aware defaults, `withRouting()` for a scoped routing policy, and `withProviders()` to add adapters without rebuilding a client. Semantic retrieval can customize the vector namespace, candidate budget, graph decay, or final deterministic ranking:

```ts
const customized = planet.withRouting({ graph: "postgres", vector: "qdrant" })

const searchPlanet = new Planet({
  providers,
  selectProvider: ({ capability }) => capability === "vector" ? "qdrant" : "postgres",
  retrieval: {
    nodeNamespace: "tenant-42:nodes",
    candidateLimit: 50,
    graphDecay: 0.7,
    ranker: ({ results }) => results.filter((result) => result.evidence.length > 0),
  },
})
```
