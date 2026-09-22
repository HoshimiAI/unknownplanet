# Lunar ADK provider contract

The Lunar-owned package is named `@lunar/storage-unknown-planet`. It has `@lunar/foundation` 1.x and `@unknown-planet/sdk` as peers, but imports neither framework's internals.

It accepts a `Planet` instance routed to PostgreSQL for SQL and vector capabilities, then exports:

```ts
await migrateUnknownPlanetStorage({ planet })

const storage = createUnknownPlanetStorage({ planet })
const memory = createUnknownPlanetMemoryProvider({ planet })
```

`storage` implements Lunar's run, session, and workflow stores. It uses revision checks and `planet.sql.transaction()` for atomic run/session commits. `memory` stores tenant-scoped records in `lunar.memories`, performs lexical search in PostgreSQL, and mirrors optional embeddings to Planet vectors under `lunar-memory:<id>`.

## Migration and rollback

The forward migration is additive and idempotent: it creates the `lunar` schema, revisioned `runs`, `sessions`, and `workflow_runs` tables, then `memories` with scope and full-text indexes. It does not modify Planet graph, document, evidence, or vector tables.

Before deployment, apply the migration with a Planet client whose SQL route uses `PostgresSqlStore`. Verify a `SELECT 1`, write a test session, and perform a semantic memory round trip. Rolling back application code is safe because all data is isolated in `lunar`; dropping that schema is a separately authorized destructive cleanup operation and is not part of normal rollback.

Lunar cache and artifact contracts are deliberately not implemented here. Once Lunar publishes those interfaces, its provider can use `planet.extension(definePlanetExtension<CacheAdapter>("cache"))` and Planet blob storage without adding a Lunar dependency to Unknown Planet.
