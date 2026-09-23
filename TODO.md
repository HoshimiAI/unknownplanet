# Unknown Planet implementation plan

Work in priority order. Completed items record shipped scope; unchecked entries remain work.

## Verification

- [x] Previous baseline: `bun run build` and `bun run test` passed with live databases (SDK 11 tests/46 assertions, PostgreSQL 6/24, MongoDB 4/18); `git diff --check` passed.
- [x] Current implementation: `bun run typecheck` and `git diff --check` pass, including package builds. Memory-job, fuzzy-resolution, cursor pagination, provider-error, and compensation changes still need database integration tests.

## P0 — blocks core product

- [x] Enforce tenant scope for Mongo graph neighbors, traversal, text search, and dependent evidence deletion; add regression coverage.
- [x] Add scoped memory CRUD/search and the memory-to-knowledge path: embeddings, optional structured entity extraction, identity/alias resolution, graph links, and source evidence.
- [x] Add `planet.query` with keyword, vector, graph expansion, document chunks, metadata/type/agent filters, result fusion, and source references.
- [x] Require production bearer keys mapped to tenant/workspace scopes; construct the request client from authenticated scope.
- [x] Add Mongo and PostgreSQL persistent integration suites gated by `UP_TEST_MONGODB_URI` and `UP_TEST_DATABASE_URL`.
- [x] Run the persistent suites against live PostgreSQL and MongoDB, including persistence, merge, identity concurrency, and ingestion-job coverage; resolve backend-specific failures.

## P1 — required before v1

- [x] Add provider-neutral entity extraction contracts, OpenAI-compatible HTTP integration, structured validation, retry, and per-ingestion deduplication.
- [x] Add configurable normalized fuzzy matching, optional vector similarity matching, concurrent exact-identity recovery, and persistent aliases for alternate names.
- [x] Add transactional `graph.node.merge` in PostgreSQL and MongoDB; redirect all incident edges, retain parallel claims/evidence, preserve source properties as target aliases, and expose before/after snapshots through merge history.
- [x] Reserve normalized canonical identity keys under PostgreSQL advisory transaction locks; SDK ingestion re-reads graph nodes after concurrent create conflicts.
- [x] Extend PostgreSQL identity resolution's advisory transaction lock across the scoped entity namespace; recheck normalized names and aliases under the lock before creating a near-match identity.
- [x] Preserve multiple evidence records with support/contradict/neutral direction and strength; update edge confidence/status deterministically for each evidence addition.
- [x] Add edge validity intervals/status and `asOf` traversal/query filtering.
- [x] Make memory, document, and chunk ingestion repeatable by stable source/content IDs; upsert graph links and evidence without duplicating them.
- [x] Add durable document ingestion jobs in PostgreSQL and MongoDB with stage checkpoints, bounded exponential retries, expiring atomic worker leases, status lookup, and idempotent replay repair.
- [x] Add durable memory jobs in PostgreSQL and MongoDB with persisted payloads, checkpoints, bounded retries, worker leases, and status lookup.
- [x] Compensate terminally failed memory jobs by deleting partial memory, vectors, graph nodes, and incident evidence where the required adapters are available.
- [x] Compensate terminally failed document jobs by removing chunks/vectors, source evidence, graph links, and the document record where adapters support deletion; cleanup failures are appended to the durable job error.
- [x] Add typed `PlanetError` subclasses and map typed errors to consistent HTTP error envelopes; missing capability failures use the typed 503 error.
- [x] Raise typed validation/not-found/conflict/provider errors across SDK adapter calls; map PostgreSQL and Mongo conflict/validation codes at the provider boundary.
- [x] Add ID-keyset cursor pages for memory search, document chunks, graph/vector search, hybrid query, evidence, identities, bindings, and graph merge history. Matching HTTP page routes cover the exposed list/search endpoints; pages order by stable IDs rather than relevance scores.
- [x] Put HTTP routes and matching OpenAPI paths under `/v1` and update API docs.
- [x] Classify storage adapter, embedding, extraction, and document parser failures in the SDK; HTTP returns the typed status/code envelope.

## P2 — important after v1

- [x] Parse plain text, Markdown, HTML, and JSON; chunk deterministically with configurable character size, overlap, offsets, and stable IDs.
- [ ] Ship a built-in PDF parser; PDF currently requires an injected `DocumentParser`.
- [x] Add an OpenAI-compatible embedding provider with model/dimension validation and support for custom embedding providers.
- [x] Add Mongo compound-index initialization and PostgreSQL migrations for memory, source evidence, temporal fields, merge history, and durable document ingestion jobs.
- [x] Apply explicit PostgreSQL schema selection consistently to graph, vector, document, chunk, evidence, memory, and SQL capabilities; migrations and vector index DDL honor the same schema while `public` remains the default.
- [x] Add vector metadata filters in PostgreSQL and Atlas Vector Search adapters.
- [x] Add OpenTelemetry traces and metrics for request correlation, model calls/reported token usage, ingestion-stage timing, SDK and provider operations, and PostgreSQL query health; export uses standard OTLP environment configuration.
- [x] Version HTTP routes under `/v1` and expose `/openapi.json`.
- [ ] Complete OpenAPI request/response schemas; `/openapi.json` currently documents the main surfaces at a high level.

## P3 — future

- [ ] Add durable event subscriptions, retrying delivery, and webhooks.
- [ ] Add Python client and MCP adapters if those integrations return to the product plan.
- [ ] Add a production-tested MCP transport/client workflow and LangChain/Vercel AI SDK/OpenAI Agents adapters.
- [ ] Add richer graph query language support and additional storage providers.
