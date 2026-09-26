import type {
  BlobStorageAdapter, CollectionStore, DataLayerProvider, DocumentChunkStore, DocumentParser, DocumentStore, EmbeddingProvider, EntityExtractor,
  Evidence, EvidenceStore, GraphEdge, GraphNode, GraphStore, IdentityStore, IngestionJobStore, MemoryStore, PlanetScope,
  PlanetJsonSchema, ProviderCapability, ProviderOperation, ProviderRouting, ProviderRoutingPolicy, QueueStore, StackStore, KeyValueStore, SqlStore, VectorCollectionConfig, VectorStore,
} from "@unknown-planet/core";

export type CustomDataKind = "graph.node" | "graph.edge" | "vector" | "document" | "chunk" | "evidence" | "memory" | "identity" | "identity.binding" | "ingestionJob" | "queue" | "stack" | "keyValue" | "blob";

/** A graph schema can target every node/edge or a specific node type/edge relation. */
export type CustomSchemaKey = CustomDataKind | `graph.node:${string}` | `graph.edge:${string}`;
/** Optional JSON Schema definitions for application data stored with Planet records. */
export type CustomSchemas = Partial<Record<CustomSchemaKey, PlanetJsonSchema>>;

export interface ProviderSelectionInput {
  capability: ProviderCapability;
  providers: readonly DataLayerProvider[];
}

/** Selects a provider when no explicit routing rule exists. */
export type ProviderSelector = (input: ProviderSelectionInput) => string | undefined;

export interface FeaturePolicyInput {
  capability: ProviderCapability;
  operation: ProviderOperation;
  scope: PlanetScope;
}

/** Returns false to deny an SDK capability operation for the current scope. */
export type FeaturePolicy = (input: FeaturePolicyInput) => boolean;

export interface RetrievalConfig {
  /** Namespace containing graph-node vectors. Defaults to `node`. */
  nodeNamespace?: string;
  /** Default graph expansion depth for semantic search. Defaults to 0. */
  defaultGraphDepth?: number;
  /** Multiplier applied once per graph hop when scoring expanded nodes. Defaults to 0.8. */
  graphDecay?: number;
  /** Number of semantic candidates requested before graph expansion. */
  candidateLimit?: number;
  /** Optional application policy run after deterministic retrieval and before the result limit. */
  ranker?: (input: { query: string; results: GraphSearchResult[] }) => GraphSearchResult[] | Promise<GraphSearchResult[]>;
}

export type PlanetQueryRanker = (input: { query: string; results: PlanetQueryResult[] }) => PlanetQueryResult[] | Promise<PlanetQueryResult[]>;

export interface PlanetHookEvent {
  /** Public SDK operation, such as `graph.node.create` or `query`. */
  operation: string;
  phase: "started" | "completed" | "failed";
  /** Elapsed time for completed and failed operations. */
  durationMs?: number;
  /** Error summary for failed operations. */
  error?: { name: string; code?: string };
}

export type PlanetHook = (event: PlanetHookEvent) => void | Promise<void>;

export interface EntityResolutionConfig { fuzzyThreshold?: number; embeddingThreshold?: number }

export interface PlanetConfig {
  /** Named providers. Each may implement any subset of the data capabilities. */
  providers?: DataLayerProvider[];
  /** Selects a provider for each capability; unspecified capabilities use the first matching provider. */
  routing?: ProviderRouting;
  /** Custom default provider selection; explicit `routing` always wins. */
  selectProvider?: ProviderSelector;
  /** Operation-aware policy for tenancy, read/write roles, replicas, and failover. */
  routingPolicy?: ProviderRoutingPolicy;
  /** Optional scope-aware SDK feature gate. Omitted capabilities remain enabled. */
  featurePolicy?: FeaturePolicy;
  /** Scope injected into all Planet domain calls. Defaults to the isolated `default` scope. */
  scope?: PlanetScope;
  /** Optional JSON validation for Planet record fields. Does not migrate databases. */
  validationSchemas?: CustomSchemas;
  /** @deprecated Use validationSchemas. This validates JSON values; it does not manage physical schemas. */
  customSchemas?: CustomSchemas;
  /** Direct adapters remain supported for a single-provider setup. */
  graph?: GraphStore;
  vector?: VectorStore;
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
  sql?: SqlStore;
  collections?: CollectionStore;
  /** Application- or package-defined capabilities for the inline provider. */
  extensions?: Record<string, unknown>;
  embeddings?: EmbeddingProvider;
  extractor?: EntityExtractor;
  documentParsers?: Record<string, DocumentParser>;
  entityResolution?: EntityResolutionConfig;
  retrieval?: RetrievalConfig;
  /** Optional application policy applied to fused results before the result limit. */
  queryRanker?: PlanetQueryRanker;
  /** Observes public SDK operation lifecycle events. Hook failures are ignored. */
  hooks?: readonly PlanetHook[];
}

export interface GraphSearchInput {
  query: string;
  semantic?: boolean;
  /** Skip edge/evidence hydration when using graph search only for candidate discovery. */
  includeContext?: boolean;
  limit?: number;
  graph?: { depth?: number };
  /** Override the configured vector namespace for this query. */
  vectorNamespace?: string;
  /** Override the configured semantic candidate budget for this query. */
  candidateLimit?: number;
  asOf?: Date;
}

export interface GraphSearchResult {
  node: GraphNode;
  score: number;
  evidence: Evidence[];
  edges: GraphEdge[];
}

export interface PlanetQueryInput {
  text: string;
  search?: { keyword?: boolean; vector?: boolean; graph?: boolean };
  filters?: { nodeType?: string; metadata?: Record<string, unknown>; agentId?: string; documentId?: string };
  expand?: { relationDepth?: number };
  includeEvidence?: boolean;
  limit?: number;
  asOf?: Date;
}

export interface PlanetQueryResult extends GraphSearchResult {
  sources: Array<{ type?: string; id?: string; documentId?: string; chunkId?: string }>;
}

export interface DocumentIngestInput {
  title: string;
  data: Uint8Array;
  contentType: string;
  contentUri?: string;
  externalId?: string;
  chunkSize?: number;
  overlap?: number;
  metadata?: Record<string, unknown>;
}

export interface DocumentIngestResult {
  document: Awaited<ReturnType<DocumentStore["create"]>>;
  chunks: Awaited<ReturnType<DocumentChunkStore["list"]>>;
  jobId?: string;
}
