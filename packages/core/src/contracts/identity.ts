import type { IdentityId, JsonObject, PlanetScope, ScopedInput } from "./common.js";

/** A stable, scoped application name that can bind records in any provider. */
export interface PlanetIdentity { id: IdentityId; namespace: string; name: string; metadata: JsonObject; createdAt: Date }
export interface CreateIdentityInput extends ScopedInput { namespace: string; name: string; metadata?: JsonObject }
export interface IdentityBinding { identityId: IdentityId; providerId: string; resourceType: string; resourceId: string; metadata: JsonObject; createdAt: Date }
export interface IdentityStore {
  create(input: CreateIdentityInput): Promise<PlanetIdentity>;
  /** Atomically finds or creates the scoped canonical identity and reserves its normalized key. */
  resolveOrCreate?(input: CreateIdentityInput & { canonicalName: string; fuzzyThreshold?: number }): Promise<PlanetIdentity>;
  get(input: ScopedInput & { namespace: string; name: string }): Promise<PlanetIdentity | null>;
  resolve(input: ScopedInput & { namespace: string; name: string }): Promise<PlanetIdentity | null>;
  list(input: ScopedInput & { namespace: string; limit?: number }): Promise<PlanetIdentity[]>;
  addAlias(input: ScopedInput & { namespace: string; alias: string; identityId: IdentityId }): Promise<void>;
  bind(input: ScopedInput & { identityId: IdentityId; providerId: string; resourceType: string; resourceId: string; metadata?: JsonObject }): Promise<IdentityBinding>;
  listBindings(input: ScopedInput & { identityId: IdentityId; limit?: number }): Promise<IdentityBinding[]>;
}
