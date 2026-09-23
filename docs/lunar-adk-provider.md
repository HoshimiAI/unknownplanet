# Lunar ADK storage integration

The Lunar-owned package is `@lunar/storage-unknown-planet` in the sibling `lunar-adk` repository. It has `@lunar/foundation` 1.x and `@unknown-planet/sdk` as peers and uses their public exports.

It accepts a `Planet` instance routed to PostgreSQL for SQL and vector capabilities, then exports:

```ts
await migrateUnknownPlanetStorage({ planet })

const storage = createUnknownPlanetStorage({ planet, scope: { tenantId: "acme" } })
```

`storage` implements Lunar's run, session, and workflow stores. It uses revision checks and `planet.sql.transaction()` for atomic run/session commits. Construct it per authenticated tenant or workspace. A Lunar `MemoryProvider` remains the next integration milestone; its expiry, owner, namespace, listing, and filtering contracts require a separate adapter.

## Migration and rollback

The forward migration is additive and idempotent: it creates the `lunar` schema and revisioned `runs`, `sessions`, and `workflow_runs` tables. It does not modify Planet graph, document, evidence, or vector tables.

Before deployment, apply the migration with a Planet client whose SQL route supports PostgreSQL transactions. Run Lunar's `verifyStorageBundle` contract check and the package's PostgreSQL integration check. Rolling back application code is safe because all data is isolated in `lunar`; dropping that schema is a separately authorized destructive cleanup operation and is not part of normal rollback.

Lunar cache and artifact contracts are deliberately not implemented here. Once Lunar publishes those interfaces, its provider can use `planet.extension(definePlanetExtension<CacheAdapter>("cache"))` and Planet blob storage without adding a Lunar dependency to Unknown Planet.
