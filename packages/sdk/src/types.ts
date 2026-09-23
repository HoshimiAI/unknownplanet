import type {
  BlobStorageAdapter, DataLayerProvider, DocumentChunkStore, DocumentParser, DocumentStore, EmbeddingProvider, EntityExtractor,
  Evidence, EvidenceStore, GraphEdge, GraphNode, GraphStore, IdentityStore, IngestionJobStore, MemoryStore, PlanetScope,
  ProviderCapability, ProviderRouting, ProviderRoutingPolicy, SqlStore, VectorStore,
} from "@unknown-planet/core";

export interface ProviderSelectionInput {
  capability: ProviderCapability;
  providers: readonly DataLayerProvider[];
}

/** Selects a provider when no explicit routing rule exists. */
export type ProviderSelector = (input: ProviderSelectionInput) => string | undefined;

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
  /** Scope injected into all Planet domain calls. Defaults to the isolated `default` scope. */
  scope?: PlanetScope;
  /** Direct adapters remain supported for a single-provider setup. */
  graph?: GraphStore;
  vector?: VectorStore;
  documents?: DocumentStore;
  chunks?: DocumentChunkStore;
  evidence?: EvidenceStore;
  memories?: MemoryStore;
  ingestionJobs?: IngestionJobStore;
  identities?: IdentityStore;
  blobs?: BlobStorageAdapter;
  sql?: SqlStore;
  /** Application- or package-defined capabilities for the inline provider. */
  extensions?: Record<string, unknown>;
  embeddings?: EmbeddingProvider;
  extractor?: EntityExtractor;
  documentParsers?: Record<string, DocumentParser>;
  entityResolution?: EntityResolutionConfig;
  retrieval?: RetrievalConfig;
  /** Optional application policy applied to fused results before the result limit. */
  queryRanker?: PlanetQueryRanker;
}

export interface GraphSearchInput {
  query: string;
  semantic?: boolean;
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
