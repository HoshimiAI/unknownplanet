export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject { [key: string]: JsonValue }

export type NodeId = string;
export type EdgeId = string;
export type DocumentId = string;
export type EvidenceId = string;

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
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateNodeInput {
  id?: NodeId;
  type: string;
  name: string;
  properties?: JsonObject;
  embedding?: number[];
}

export interface UpdateNodeInput {
  type?: string;
  name?: string;
  properties?: JsonObject;
  embedding?: number[] | null;
}

export interface CreateEdgeInput {
  id?: EdgeId;
  from: NodeId;
  to: NodeId;
  relation: string;
  properties?: JsonObject;
  confidence?: number;
}

export type GraphDirection = "outbound" | "inbound" | "both";
export interface NeighborsInput { nodeId: NodeId; direction?: GraphDirection; relation?: string; limit?: number }
export interface TraverseInput { startIds: NodeId[]; depth: number; direction?: GraphDirection; relation?: string; limit?: number }
export interface GraphTraversal { nodes: GraphNode[]; edges: GraphEdge[]; depthByNode: Record<NodeId, number> }
export interface GraphTextSearchInput { query: string; limit?: number }

export interface GraphStore {
  createNode(input: CreateNodeInput): Promise<GraphNode>;
  getNode(id: NodeId): Promise<GraphNode | null>;
  updateNode(id: NodeId, input: UpdateNodeInput): Promise<GraphNode | null>;
  /** Deletes the node and, by contract, all incident edges and their evidence. */
  deleteNode(id: NodeId): Promise<boolean>;
  createEdge(input: CreateEdgeInput): Promise<GraphEdge>;
  getEdge(id: EdgeId): Promise<GraphEdge | null>;
  deleteEdge(id: EdgeId): Promise<boolean>;
  neighbors(input: NeighborsInput): Promise<GraphEdge[]>;
  traverse(input: TraverseInput): Promise<GraphTraversal>;
  searchNodes(input: GraphTextSearchInput): Promise<GraphNode[]>;
}

export interface VectorRecord { id: string; namespace: string; embedding: number[]; metadata?: JsonObject }
export interface VectorSearchInput { embedding: number[]; namespace?: string; limit?: number }
export interface VectorSearchResult { id: string; namespace: string; score: number; metadata: JsonObject }
export interface VectorStore {
  upsert(input: VectorRecord): Promise<void>;
  search(input: VectorSearchInput): Promise<VectorSearchResult[]>;
  delete(id: string): Promise<void>;
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
export interface CreateDocumentInput { id?: DocumentId; externalId?: string; title: string; contentUri: string; metadata?: JsonObject }
export interface DocumentStore {
  create(input: CreateDocumentInput): Promise<PlanetDocument>;
  get(id: DocumentId): Promise<PlanetDocument | null>;
}

export interface Evidence {
  id: EvidenceId;
  edgeId: EdgeId;
  documentId: DocumentId;
  chunkId?: string;
  sourceType?: string;
  extractor: string;
  confidence?: number;
  metadata: JsonObject;
  createdAt: Date;
}
export interface AddEvidenceInput {
  id?: EvidenceId; edgeId: EdgeId; documentId: DocumentId; chunkId?: string;
  sourceType?: string; extractor: string; confidence?: number; metadata?: JsonObject;
}
export interface EvidenceListInput { edgeId?: EdgeId; edgeIds?: EdgeId[]; documentId?: DocumentId; limit?: number }
export interface EvidenceStore { add(input: AddEvidenceInput): Promise<Evidence>; list(input: EvidenceListInput): Promise<Evidence[]> }

/** Stores source bytes outside PostgreSQL; documents retain only a content URI. */
export interface BlobStorageAdapter {
  put(input: { key: string; data: Uint8Array; contentType?: string }): Promise<{ uri: string }>;
  get(uri: string): Promise<Uint8Array>;
  delete(uri: string): Promise<void>;
}

export interface EmbeddingProvider { embed(input: { text: string }): Promise<number[]> }

/**
 * A named implementation of one or more data capabilities. Providers can be mixed:
 * e.g. PostgreSQL for graph/evidence, Qdrant for vectors, and S3 for blobs.
 */
export interface DataLayerProvider {
  id: string;
  graph?: GraphStore;
  vector?: VectorStore;
  documents?: DocumentStore;
  evidence?: EvidenceStore;
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
  evidence?: string;
  blobs?: string;
  sql?: string;
  /** Routes arbitrary provider extensions by their registered key. */
  extensions?: Record<string, string>;
}

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
