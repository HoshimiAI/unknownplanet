# Unknown Planet

An AI-native data-layer orchestrator for graph, vector, document, and evidence retrieval. It is not a database engine or ORM. Applications depend on one SDK while adapters route each data capability to the appropriate provider.

## Packages

- `@unknown-planet/core` — domain types and storage contracts; no PostgreSQL imports.
- `@unknown-planet/postgres` — PostgreSQL/pgvector adapters and SQL migration.
- `@unknown-planet/mongodb` — MongoDB graph/document/evidence adapters and Atlas Vector Search.
- `@unknown-planet/sdk` — the `Planet` client and deterministic hybrid retrieval pipeline.

Core contracts are grouped by domain in `packages/core/src/contracts`. The SDK keeps the public `Planet` facade in `packages/sdk/src/client/planet.ts`; graph search and hybrid query live beside it, while document and memory workflows live in `packages/sdk/src/client/ingestion`. Framework-specific integrations can depend on these package entry points without importing internal files.

## Commands

```sh
bun install
bun run build
bun run typecheck
bun run lint
bun run test
```

## Install in another repository

After a release is published to the public npm registry, packages can be installed directly without linking this checkout. For Lunar's PostgreSQL storage provider, install its peer dependencies and the Planet packages:

```sh
bun add @unknown-planet/sdk @unknown-planet/postgres @unknown-planet/core
```

Use `@unknown-planet/mongodb` instead of `@unknown-planet/postgres` for the MongoDB adapter. Keep the packages on compatible releases; adapter packages depend on `@unknown-planet/core` using a semver range. The first release of a set must publish `core` before `sdk`, `postgres`, or `mongodb`.

## Live Elysia smoke test

Start PostgreSQL with pgvector and the Unknown Planet migration:

```sh
docker compose up -d postgres
docker compose ps
bun run --cwd apps/elysia dev
```

The versioned API listens under `http://localhost:3000/v1`. It uses a deterministic demo embedding only to exercise vector retrieval locally; configure a real embedding provider before production use. The demo scope defaults to `TENANT_ID=local-dev`; set `WORKSPACE_ID` for a workspace and `PLANET_SCHEMA` for the PostgreSQL schema containing all Planet tables. A production application should derive scope from verified authentication context.

Copy `.env.example` to `.env` for local settings. Production startup requires `API_KEYS` (a JSON object mapping bearer tokens to tenant scopes), `OPENAI_API_KEY`, and `LLM_API_KEY`/`LLM_API_URL`/`LLM_MODEL`. The embedding adapter supports OpenAI-compatible endpoints; entity extraction expects a JSON chat-completion response with an `entities` array. Never use the local demo embedding in production.

OpenTelemetry tracing and metrics export over OTLP/HTTP is optional. Set `OTEL_EXPORTER_OTLP_ENDPOINT` to the collector base URL (or use the standard trace/metric endpoint variables) to enable it; `OTEL_SERVICE_NAME` sets the service resource name. SDK/application instrumentation covers HTTP requests, query/memory/document ingestion operations and stages, embedding/extraction calls and reported token usage, and storage-adapter calls for every provider. PostgreSQL additionally records per-query durations and errors. Request logs include request, trace, and span IDs. Prompts, SQL text/parameters, credentials, and tenant IDs are not recorded. Exporter configuration follows the standard `OTEL_*` environment variables; set `OTEL_SDK_DISABLED=true` to disable SDK initialization.

```sh
curl http://localhost:3000/v1/health

curl -X POST http://localhost:3000/v1/nodes \
  -H 'content-type: application/json' \
  -d '{"type":"method","name":"Transformer","embedding":[0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8]}'

curl -X POST http://localhost:3000/v1/nodes/DUPLICATE_NODE_ID/merge \
  -H 'content-type: application/json' \
  -d '{"targetId":"CANONICAL_NODE_ID"}'

curl -X POST http://localhost:3000/v1/memory \
  -H 'content-type: application/json' \
  -d '{"agentId":"research-agent","content":"Attention improved forecasting performance","source":{"type":"experiment","id":"exp-42"}}'

curl -X POST http://localhost:3000/v1/query \
  -H 'content-type: application/json' \
  -d '{"text":"Does attention improve forecasting?","search":{"keyword":true,"vector":true,"graph":true},"includeEvidence":true}'

curl -X POST http://localhost:3000/v1/ingestion-jobs/run-due \
  -H 'content-type: application/json' \
  -d '{"limit":10}'

curl http://localhost:3000/v1/openapi.json

curl -X POST http://localhost:3000/v1/identities \
  -H 'content-type: application/json' \
  -d '{"namespace":"lunar.memory","name":"thread_42"}'

curl 'http://localhost:3000/v1/identities/resolve?namespace=lunar.memory&name=thread_42'

IDENTITY_ID=replace-with-created-identity-id
curl -X POST "http://localhost:3000/v1/identities/$IDENTITY_ID/bindings" \
  -H 'content-type: application/json' \
  -d '{"providerId":"lunar-postgres","resourceType":"memory","resourceId":"42"}'

DOCUMENT_ID=replace-with-created-document-id
curl -X POST "http://localhost:3000/v1/documents/$DOCUMENT_ID/chunks" \
  -H 'content-type: application/json' \
  -d '{"text":"Attention is all you need.","startOffset":0,"endOffset":26}'
```

Compose initializes a new Docker volume with the ordered PostgreSQL migrations. Its MongoDB service runs as a single-node replica set so transactional graph merges work locally. To reinitialize a local test database after changing a migration, run `docker compose down -v` and then start it again; this deletes local Compose data.

Document ingestion returns a `jobId`; failed responses include the `jobId` in the error envelope. Read a job at `/v1/ingestion-jobs/{id}`. A worker can poll `/v1/ingestion-jobs/run-due`; adapters atomically lease due work and retry it with bounded backoff. Replay uses stable document, chunk, vector, and graph IDs. The original source bytes are retained in the job payload until the job record is removed.

`bun run --cwd packages/postgres migrate` applies ordered migrations to an existing database using `DATABASE_URL`. Set `PLANET_SCHEMA` for both migrations and `createPostgresProvider({ schema })` to keep the provider and migration target aligned; it defaults to `public`. Each schema has its own migration history. The provider routes graph, vector, document, chunk, evidence, memory, ingestion, and identity tables to that schema, and SQL queries use it as their default search path (with `public` available as a fallback). For destructive integration tests, point `UP_TEST_DATABASE_URL` at a dedicated migrated PostgreSQL database and `UP_TEST_MONGODB_URI` at a disposable MongoDB instance; the integration suites run only when these variables are set. `docker compose up -d` starts PostgreSQL and MongoDB for local development. Call `initializeMongoIndexes(db)` once during MongoDB adapter startup; Atlas Vector Search index creation remains an Atlas configuration step.

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

The SDK also offers the v1 memory and query path:

```ts
const planet = new Planet({ providers: [createPostgresProvider({ database: pool })], embeddings, extractor })
const scoped = planet.withScope({ tenantId: "acme" })
await scoped.memory.add({ agentId: "research-agent", content: "Attention improved forecasting performance", source: { type: "experiment", id: "exp-42" } })
const answer = await scoped.query({ text: "Does attention improve forecasting?", search: { keyword: true, vector: true, graph: true }, includeEvidence: true })
```

Memory writes are idempotent when the caller supplies a stable `id` or `source` identity. They are embedded and indexed, optionally passed through the configured entity extractor, linked to resolved graph entities, and attached to source-aware evidence. The query fuses keyword, vector, graph, and indexed document-chunk results and returns source references. Cross-provider operations are not transactional: retry failed writes using the same source identity.

Framework adapters that own their memory lifecycle can use `memory.persist()` for scoped CRUD storage without invoking Planet's embedding, vector, or graph ingestion pipeline. `memory.add()` remains the higher-level knowledge ingestion path:

```ts
const frameworkMemory = await scoped.memory.persist({
  id: "framework-memory-42",
  agentId: "research-agent",
  content: "Attention improved forecasting performance",
  source: { type: "framework-session", id: "thread-42" },
})
```

SDK page methods return `{ items, nextCursor }`; pass `nextCursor` as `cursor` on the next request. They order results by stable record IDs for predictable continuation. The HTTP API exposes matching `/page` routes for memory, document chunks, graph search, hybrid query, evidence, and identity bindings.

Use `OpenAICompatibleEmbeddingProvider` and `JsonHttpEntityExtractor` from `@unknown-planet/sdk`; both can target hosted or OpenAI-compatible local HTTP services. PDF parsing requires a supplied `DocumentParser`; built-in parsing supports plain text, Markdown, HTML, and JSON. Chunk size and overlap are configurable in `planet.document.ingest`.

## Production scope, chunks, and vectors

Create a scoped client for each authenticated tenant or workspace. Scope is injected by the SDK and enforced by the PostgreSQL and MongoDB adapters:

```ts
const acme = planet.withScope({ tenantId: "acme", workspaceId: "research" })
const document = await acme.document.create({ title: "Paper", contentUri: "s3://sources/paper.pdf" })
const chunk = await acme.document.chunk.create({ documentId: document.id, text: "Attention is all you need.", startOffset: 0, endOffset: 26 })
```

Vectors are isolated by scope, namespace, and id. Deletion therefore requires both identity fields:

```ts
await acme.vector.delete({ id: "node_42", namespace: "node" })
```

For an existing V1 PostgreSQL database, apply `packages/postgres/migrations/002_production_core.sql` before deploying this release. It preserves all rows in the `default` scope. Configure fixed dimensions per vector namespace and execute `pgVectorCollectionIndexSql(namespace, dimensions)` once per namespace to create its HNSW index.

## Stable names across Planet, Lunar, and apps

Route the identity catalog to one durable provider. It gives graph records, Lunar ADK records, and normal application rows one scoped, immutable reference without copying data between databases.

```ts
const identity = await planet.withScope({ tenantId: "acme" }).nameId.create({
  namespace: "lunar.memory",
  name: "thread_42",
})

await planet.nameId.bind({
  identityId: identity.id,
  providerId: "lunar-postgres",
  resourceType: "memory",
  resourceId: "42",
})
```

`createPostgresProvider({ schema: "planet" })` routes all Planet tables, including the identity catalog, to the `planet` PostgreSQL schema. Run migrations with `PLANET_SCHEMA=planet` to create and track those tables there. Create and migrate Lunar and application schemas independently.

Apply `packages/postgres/migrations/004_memory_sources.sql` when upgrading an existing database to memory, source-backed evidence, and temporal edge fields. Fresh Compose databases receive it during initialization.

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

const project = await planet.sql.execute<{ id: string; name: string }>({
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

`planet.sql.query()` uses the `read` route; `planet.sql.execute()` uses the `write` route. This lets a `routingPolicy` send reads to a replica and writes to a primary. A fixed `routing.sql` entry takes precedence for both. `planet.sql` is available only when the selected provider implements `SqlStore`; MongoDB providers intentionally do not expose SQL.

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

Lunar ADK integrates through a Lunar-owned custom provider package. The provider consumes a configured `Planet` instance and currently implements Lunar's `StorageBundle` contract using PostgreSQL SQL transactions.

The integration requires a PostgreSQL-routed `planet.sql` capability because Lunar run/session persistence relies on atomic transactions. It stores Lunar runs, sessions, and workflows in a dedicated `lunar` schema; source graph/document data stays in the existing Planet domains. Lunar memory integration is the next package milestone.

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

`retrieval.ranker` customizes semantic graph search. `queryRanker` receives the complete fused `planet.query()` result set after filters and can apply application scoring before the result limit. `queryPage()` continues to order by stable IDs for cursor pagination.
