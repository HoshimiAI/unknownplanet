import type { PlanetScope } from "./common.js";
import type { GraphStore } from "./graph.js";
import type { VectorStore } from "./vector.js";
import type { DocumentChunkStore, DocumentStore } from "./document.js";
import type { EvidenceStore } from "./evidence.js";
import type { MemoryStore } from "./memory.js";
import type { IngestionJobStore } from "./ingestion.js";
import type { IdentityStore } from "./identity.js";

/** Stores source bytes outside PostgreSQL; documents retain only a content URI. */
export interface BlobStorageAdapter {
  put(input: { key: string; data: Uint8Array; contentType?: string }): Promise<{ uri: string }>;
  get(uri: string): Promise<Uint8Array>;
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
  blobs?: BlobStorageAdapter;
  /** Optional relational capability, for providers that support SQL. */
  sql?: SqlStore;
  /** Application- or package-defined capabilities not owned by the core SDK. */
  extensions?: Record<string, unknown>;
}

export interface ProviderRouting {
  graph?: string;
  vector?: string;
  documents?: string;
  chunks?: string;
  evidence?: string;
  memories?: string;
  ingestionJobs?: string;
  identities?: string;
  blobs?: string;
  sql?: string;
  /** Routes arbitrary provider extensions by their registered key. */
  extensions?: Record<string, string>;
}

export type ProviderCapability = "graph" | "vector" | "documents" | "chunks" | "evidence" | "memories" | "ingestionJobs" | "identities" | "blobs" | "sql";
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
