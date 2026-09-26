import type { JsonObject, PlanetScope } from "./common.js";
import type { GraphStore } from "./graph.js";
import type { VectorStore } from "./vector.js";
import type { DocumentChunkStore, DocumentStore } from "./document.js";
import type { EvidenceStore } from "./evidence.js";
import type { MemoryStore } from "./memory.js";
import type { IngestionJobStore } from "./ingestion.js";
import type { IdentityStore } from "./identity.js";
import type { KeyValueStore } from "./key-value.js";
import type { QueueStore } from "./queue.js";
import type { StackStore } from "./stack.js";
import type { CollectionStore } from "./collection.js";

/** Stores source bytes outside PostgreSQL; documents retain only a content URI. */
export interface BlobStorageAdapter {
  put(input: { key: string; data: Uint8Array; contentType?: string; metadata?: JsonObject }): Promise<{ uri: string }>;
  get(uri: string): Promise<Uint8Array>;
  getMetadata?(uri: string): Promise<JsonObject>;
  delete(uri: string): Promise<void>;
}

export interface EmbeddingProvider { readonly model: string; readonly dimensions: number; embed(input: { text: string }): Promise<number[]>; embedMany?(inputs: string[]): Promise<number[][]> }
export interface VectorCollectionConfig { dimensions: number; model?: string }

/**
 * A named implementation of one or more data capabilities. Providers can be mixed:
 * e.g. PostgreSQL for graph/evidence, Qdrant for vectors, and S3 for blobs.
 */
export interface DataLayerProvider {
  id: string;
  graph?: GraphStore;
  vector?: VectorStore;
  /** Expected embedding dimensions/model for named vector namespaces. */
  vectorCollections?: Readonly<Record<string, VectorCollectionConfig>>;
  documents?: DocumentStore;
  chunks?: DocumentChunkStore;
  evidence?: EvidenceStore;
  memories?: MemoryStore;
  ingestionJobs?: IngestionJobStore;
  identities?: IdentityStore;
  queue?: QueueStore;
  stack?: StackStore;
  keyValue?: KeyValueStore;
  blobs?: BlobStorageAdapter;
  /** Optional relational capability, for providers that support SQL. */
  sql?: SqlStore;
  /** Application-owned collections, queried through a provider without exposing its client. */
  collections?: CollectionStore;
  /** Application- or package-defined capabilities not owned by the core SDK. */
  extensions?: Record<string, unknown>;
}

/**
 * Optional provider-native namespace overrides, keyed by capability.
 * A value is interpreted by the provider (for example, a PostgreSQL schema,
 * collection prefix, graph label prefix, Redis key prefix, or blob key prefix).
 * Providers ignore capabilities they do not implement.
 */
export type ProviderSchemaMap = Partial<Record<ProviderCapability, string>>;

export interface ProviderRouting {
  graph?: string;
  vector?: string;
  documents?: string;
  chunks?: string;
  evidence?: string;
  memories?: string;
  ingestionJobs?: string;
  identities?: string;
  queue?: string;
  stack?: string;
  keyValue?: string;
  blobs?: string;
  sql?: string;
  collections?: string;
  /** Routes arbitrary provider extensions by their registered key. */
  extensions?: Record<string, string>;
}

export type ProviderCapability = "graph" | "vector" | "documents" | "chunks" | "evidence" | "memories" | "ingestionJobs" | "identities" | "queue" | "stack" | "keyValue" | "blobs" | "sql" | "collections";
export type ProviderOperation = "read" | "write" | "search" | "transaction";
export interface ProviderRouteRequest { capability: ProviderCapability; operation: ProviderOperation; scope: PlanetScope; providers: readonly DataLayerProvider[] }
/** Dynamic routing for tenancy, read/write roles, replicas, and provider health policies. */
export type ProviderRoutingPolicy = (request: ProviderRouteRequest) => string | undefined;

/** Parameterized relational SQL capability. Never interpolate untrusted values into `text`. */
export interface SqlQueryInput { text: string; values?: readonly unknown[] }
export interface SqlQueryResult<T extends Record<string, unknown> = Record<string, unknown>> { rows: T[]; rowCount: number }
export interface SqlTransaction {
  query<T extends Record<string, unknown> = Record<string, unknown>>(input: SqlQueryInput): Promise<SqlQueryResult<T>>;
}
export interface SqlStore extends SqlTransaction {
  /** Runs work atomically when the selected relational provider supports transactions. */
  transaction?<T>(work: (transaction: SqlTransaction) => Promise<T>): Promise<T>;
}
