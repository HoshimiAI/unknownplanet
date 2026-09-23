export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject { [key: string]: JsonValue }

export type NodeId = string;
export type EdgeId = string;
export type DocumentId = string;
export type EvidenceId = string;
export type IdentityId = string;

/** The isolation boundary for every Planet record. Applications normally create one scoped client per request. */
export interface PlanetScope { tenantId: string; workspaceId?: string }
export interface ScopedInput { scope?: PlanetScope }

export interface GraphNode {
  id: NodeId;
  type: string;
  name: string;
  properties: JsonObject;
  embedding?: number[];
  createdAt: Date;
  updatedAt: Date;
}

export interface GraphEdge {
  id: EdgeId;
  sourceId: NodeId;
  targetId: NodeId;
  relation: string;
  properties: JsonObject;
  confidence?: number;
  validFrom?: Date;
  validTo?: Date;
  status?: "candidate" | "canonical" | "disputed" | "rejected" | "deprecated";
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateNodeInput extends ScopedInput {
  id?: NodeId;
  type: string;
  name: string;
  properties?: JsonObject;
  embedding?: number[];
}

export interface UpdateNodeInput extends ScopedInput {
  type?: string;
  name?: string;
  properties?: JsonObject;
  embedding?: number[] | null;
}

export interface CreateEdgeInput extends ScopedInput {
  id?: EdgeId;
  from: NodeId;
  to: NodeId;
  relation: string;
  properties?: JsonObject;
  confidence?: number;
  validFrom?: Date;
  validTo?: Date;
  status?: GraphEdge["status"];
}
export interface UpdateEdgeInput extends ScopedInput { confidence?: number; status?: GraphEdge["status"]; validFrom?: Date | null; validTo?: Date | null; properties?: JsonObject }

export type GraphDirection = "outbound" | "inbound" | "both";
export interface NeighborsInput extends ScopedInput { nodeId: NodeId; direction?: GraphDirection; relation?: string; limit?: number; asOf?: Date }
export interface TraverseInput extends ScopedInput { startIds: NodeId[]; depth: number; direction?: GraphDirection; relation?: string; limit?: number; asOf?: Date }
export interface GraphTraversal { nodes: GraphNode[]; edges: GraphEdge[]; depthByNode: Record<NodeId, number> }
export interface NodeMergeRecord { sourceId: NodeId; targetId: NodeId; mergedAt: Date; source: GraphNode; targetBefore: GraphNode; targetAfter: GraphNode }
export interface GraphTextSearchInput extends ScopedInput { query: string; limit?: number }

export interface GraphStore {
  createNode(input: CreateNodeInput): Promise<GraphNode>;
  getNode(id: NodeId, scope?: PlanetScope): Promise<GraphNode | null>;
  updateNode(id: NodeId, input: UpdateNodeInput): Promise<GraphNode | null>;
  /** Deletes the node and, by contract, all incident edges and their evidence. */
  deleteNode(id: NodeId, scope?: PlanetScope): Promise<boolean>;
  /** Atomically redirects incident edges/evidence, removes the duplicate, and records an audit entry. */
  mergeNodes?(input: ScopedInput & { sourceId: NodeId; targetId: NodeId }): Promise<NodeMergeRecord>;
  listMerges?(input: ScopedInput & { nodeId?: NodeId; limit?: number }): Promise<NodeMergeRecord[]>;
  createEdge(input: CreateEdgeInput): Promise<GraphEdge>;
  getEdge(id: EdgeId, scope?: PlanetScope): Promise<GraphEdge | null>;
  updateEdge(id: EdgeId, input: UpdateEdgeInput): Promise<GraphEdge | null>;
  deleteEdge(id: EdgeId, scope?: PlanetScope): Promise<boolean>;
  neighbors(input: NeighborsInput): Promise<GraphEdge[]>;
  traverse(input: TraverseInput): Promise<GraphTraversal>;
  searchNodes(input: GraphTextSearchInput): Promise<GraphNode[]>;
}

export interface VectorRecord extends ScopedInput { id: string; namespace: string; embedding: number[]; metadata?: JsonObject; model?: string }
export interface VectorSearchInput extends ScopedInput { embedding: number[]; namespace?: string; limit?: number; model?: string; metadata?: JsonObject }
export interface VectorSearchResult { id: string; namespace: string; score: number; metadata: JsonObject }
export interface VectorStore {
  upsert(input: VectorRecord): Promise<void>;
  search(input: VectorSearchInput): Promise<VectorSearchResult[]>;
  delete(input: { id: string; namespace: string; scope?: PlanetScope }): Promise<void>;
}

export interface PlanetDocument {
  id: DocumentId;
  externalId?: string;
  title: string;
  contentUri: string;
  metadata: JsonObject;
  createdAt: Date;
  updatedAt: Date;
}
export interface CreateDocumentInput extends ScopedInput { id?: DocumentId; externalId?: string; title: string; contentUri: string; metadata?: JsonObject }
export interface DocumentStore {
  create(input: CreateDocumentInput): Promise<PlanetDocument>;
  get(id: DocumentId, scope?: PlanetScope): Promise<PlanetDocument | null>;
  delete?(id: DocumentId, scope?: PlanetScope): Promise<boolean>;
}

export interface DocumentChunk {
  id: string; documentId: DocumentId; contentUri?: string; text?: string; startOffset?: number; endOffset?: number;
  metadata: JsonObject; createdAt: Date; updatedAt: Date;
}
export interface CreateDocumentChunkInput extends ScopedInput {
  id?: string; documentId: DocumentId; contentUri?: string; text?: string; startOffset?: number; endOffset?: number; metadata?: JsonObject;
}
export interface DocumentChunkStore {
  create(input: CreateDocumentChunkInput): Promise<DocumentChunk>;
  get(id: string, scope?: PlanetScope): Promise<DocumentChunk | null>;
  list(input: ScopedInput & { documentId: DocumentId; limit?: number }): Promise<DocumentChunk[]>;
  listPage?(input: ScopedInput & { documentId: DocumentId; limit?: number; afterId?: string }): Promise<{ items: DocumentChunk[]; hasMore: boolean }>;
  search(input: ScopedInput & { query: string; limit?: number }): Promise<DocumentChunk[]>;
  deleteExcept(input: ScopedInput & { documentId: DocumentId; keepIds: string[] }): Promise<number>;
}

export interface DocumentParser { parse(input: { data: Uint8Array; contentType: string }): Promise<string> | string }

export type IngestionJobStatus = "queued" | "processing" | "retry_wait" | "succeeded" | "failed";
export type IngestionCheckpoint = "queued" | "parsed" | "document_saved" | "chunks_saved" | "vectors_saved" | "knowledge_saved" | "memory_saved" | "completed";
export interface IngestionJob extends ScopedInput {
  id: string; kind: "document" | "memory"; status: IngestionJobStatus; checkpoint: IngestionCheckpoint; attempts: number; maxAttempts: number;
  input: JsonObject; nextAttemptAt?: Date; leaseUntil?: Date; lastError?: string; createdAt: Date; updatedAt: Date;
}
export interface CreateIngestionJobInput extends ScopedInput { id: string; kind: "document" | "memory"; input: JsonObject; maxAttempts?: number }
export interface UpdateIngestionJobInput extends ScopedInput { id: string; status?: IngestionJobStatus; checkpoint?: IngestionCheckpoint; attempts?: number; input?: JsonObject; nextAttemptAt?: Date | null; leaseUntil?: Date | null; lastError?: string | null }
export interface IngestionJobStore {
  create(input: CreateIngestionJobInput): Promise<IngestionJob>;
  get(id: string, scope?: PlanetScope): Promise<IngestionJob | null>;
  update(input: UpdateIngestionJobInput): Promise<IngestionJob>;
  claimDue(input: ScopedInput & { now?: Date; limit?: number; leaseMs?: number }): Promise<IngestionJob[]>;
}

export interface Evidence {
  id: EvidenceId;
  edgeId: EdgeId;
  documentId?: DocumentId;
  sourceId?: string;
  chunkId?: string;
  sourceType?: string;
  extractor: string;
  confidence?: number;
  direction?: "support" | "contradict" | "neutral";
  strength?: number;
  metadata: JsonObject;
  createdAt: Date;
}
export interface AddEvidenceInput extends ScopedInput {
  id?: EvidenceId; edgeId: EdgeId; documentId?: DocumentId; sourceId?: string; chunkId?: string;
  sourceType?: string; extractor: string; confidence?: number; direction?: Evidence["direction"]; strength?: number; metadata?: JsonObject;
}
export interface EvidenceListInput extends ScopedInput { edgeId?: EdgeId; edgeIds?: EdgeId[]; documentId?: DocumentId; sourceId?: string; limit?: number }
export interface EvidenceStore { add(input: AddEvidenceInput): Promise<Evidence>; list(input: EvidenceListInput): Promise<Evidence[]>; deleteByDocument?(input: ScopedInput & { documentId: DocumentId }): Promise<number> }

export type MemoryType = "fact" | "observation" | "episode" | "decision" | "preference" | "instruction" | "summary";
export interface MemorySource { type: string; id: string; documentId?: DocumentId; chunkId?: string }
export interface MemoryRecord extends ScopedInput {
  id: string; agentId: string; content: string; type: MemoryType; userId?: string; sessionId?: string;
  importance?: number; confidence?: number; source?: MemorySource; metadata: JsonObject; createdAt: Date; updatedAt: Date;
}
export interface AddMemoryInput extends ScopedInput {
  id?: string; agentId: string; content: string; type?: MemoryType; userId?: string; sessionId?: string;
  importance?: number; confidence?: number; source?: MemorySource; metadata?: JsonObject;
}
export interface MemorySearchInput extends ScopedInput {
  agentId?: string; userId?: string; sessionId?: string; query?: string; limit?: number;
  type?: MemoryType; metadata?: JsonObject;
}
export interface MemoryStore {
  add(input: AddMemoryInput): Promise<MemoryRecord>;
  get(id: string, scope?: PlanetScope): Promise<MemoryRecord | null>;
  search(input: MemorySearchInput): Promise<MemoryRecord[]>;
  searchPage?(input: MemorySearchInput & { afterId?: string }): Promise<{ items: MemoryRecord[]; hasMore: boolean }>;
  delete(id: string, scope?: PlanetScope): Promise<boolean>;
}

export interface ExtractedEntity { name: string; type: string; aliases?: string[] }
export interface EntityExtractor { extract(input: { text: string }): Promise<ExtractedEntity[]> }

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

/** Stores source bytes outside PostgreSQL; documents retain only a content URI. */
export interface BlobStorageAdapter {
  put(input: { key: string; data: Uint8Array; contentType?: string }): Promise<{ uri: string }>;
  get(uri: string): Promise<Uint8Array>;
  delete(uri: string): Promise<void>;
}

export interface EmbeddingProvider { readonly model?: string; embed(input: { text: string }): Promise<number[]> }

/**
 * A named implementation of one or more data capabilities. Providers can be mixed:
 * e.g. PostgreSQL for graph/evidence, Qdrant for vectors, and S3 for blobs.
 */
export interface DataLayerProvider {
  id: string;
  graph?: GraphStore;
  vector?: VectorStore;
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
