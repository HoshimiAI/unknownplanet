import type { Db, Document, Filter } from "mongodb";
import type {
  AddEvidenceInput, AddMemoryInput, ClaimedQueueMessage, CollectionStore, CreateDocumentChunkInput, CreateDocumentInput, CreateEdgeInput, CreateNodeInput, DataLayerProvider, ProviderSchemaMap,
  CreateIngestionJobInput, DocumentChunk, DocumentChunkStore, DocumentId, DocumentStore, EdgeId, Evidence, EvidenceListInput, EvidenceStore, GraphEdge, IngestionJob, IngestionJobStore,
  GraphNode, GraphStore, GraphTextSearchInput, GraphTraversal, JsonObject, MemoryRecord, MemorySearchInput, MemoryStore, NeighborsInput, NodeId, NodeMergeRecord, PlanetDocument,
  PlanetScope, TraverseInput, UpdateEdgeInput, UpdateIngestionJobInput, UpdateNodeInput, VectorRecord, VectorSearchInput, VectorSearchResult, VectorStore, JsonValue, QueueMessage, QueueStore, StackStore, KeyValueStore,
} from "@unknown-planet/core";
import { EmbeddingDimensionMismatchError } from "@unknown-planet/core";
import { scopeStorageKey } from "@unknown-planet/core";

interface NodeDoc extends Document { _id: string; scopeId: string; type: string; name: string; properties: JsonObject; embedding?: number[]; createdAt: Date; updatedAt: Date }
interface EdgeDoc extends Document { _id: string; scopeId: string; sourceId: string; targetId: string; relation: string; properties: JsonObject; confidence?: number; validFrom?: Date; validTo?: Date; status?: GraphEdge["status"]; createdAt: Date; updatedAt: Date }
interface SourceDoc extends Document { _id: string; scopeId: string; externalId?: string; title: string; contentUri: string; metadata: JsonObject; createdAt: Date; updatedAt: Date }
interface ChunkDoc extends Document { _id: string; scopeId: string; documentId: string; contentUri?: string; text?: string; startOffset?: number; endOffset?: number; metadata: JsonObject; createdAt: Date; updatedAt: Date }
interface EvidenceDoc extends Document { _id: string; scopeId: string; edgeId: string; documentId?: string; sourceId?: string; chunkId?: string; sourceType?: string; extractor: string; confidence?: number; direction?: Evidence["direction"]; strength?: number; metadata: JsonObject; createdAt: Date }
interface MemoryDoc extends Document { _id: string; scopeId: string; agentId: string; userId?: string; sessionId?: string; content: string; type: MemoryRecord["type"]; importance?: number; confidence?: number; source?: MemoryRecord["source"]; metadata: JsonObject; createdAt: Date; updatedAt: Date }
interface VectorDoc extends Document { _id: string; id: string; scopeId: string; namespace: string; model?: string; embedding: number[]; metadata: JsonObject; createdAt: Date; updatedAt: Date }
interface NodeMergeDoc extends Document { scopeId: string; sourceId: string; targetId: string; mergedAt: Date; source: GraphNode; targetBefore: GraphNode; targetAfter: GraphNode }
interface IngestionJobDoc extends Document { _id: string; scopeId: string; kind: IngestionJob["kind"]; status: IngestionJob["status"]; checkpoint: IngestionJob["checkpoint"]; attempts: number; maxAttempts: number; input: JsonObject; nextAttemptAt: Date; leaseUntil?: Date; leaseToken?: string; lastError?: string; createdAt: Date; updatedAt: Date }
interface QueueDoc extends Document { _id: string; scopeId: string; queue: string; value: JsonValue; status: "ready" | "leased"; attempts: number; availableAt: Date; leaseUntil?: Date; leaseToken?: string; createdAt: Date }
interface StackEntryDoc extends Document { _id: string; scopeId: string; stack: string; sequence: number; value: JsonValue; createdAt: Date }
interface StackCounterDoc extends Document { scopeId: string; stack: string; sequence: number }
interface KeyValueDoc extends Document { scopeId: string; namespace: string; key: string; value: JsonValue; expiresAt?: Date; updatedAt: Date }
const scopeId = scopeStorageKey;

const node = (value: NodeDoc): GraphNode => ({ id: value._id, type: value.type, name: value.name, properties: value.properties ?? {}, embedding: value.embedding, createdAt: value.createdAt, updatedAt: value.updatedAt });
const edge = (value: EdgeDoc): GraphEdge => ({ id: value._id, sourceId: value.sourceId, targetId: value.targetId, relation: value.relation, properties: value.properties ?? {}, confidence: value.confidence, validFrom: value.validFrom, validTo: value.validTo, status: value.status ?? "candidate", createdAt: value.createdAt, updatedAt: value.updatedAt });
const source = (value: SourceDoc): PlanetDocument => ({ id: value._id, externalId: value.externalId, title: value.title, contentUri: value.contentUri, metadata: value.metadata ?? {}, createdAt: value.createdAt, updatedAt: value.updatedAt });
const chunk = (value: ChunkDoc): DocumentChunk => ({ id: value._id, documentId: value.documentId, contentUri: value.contentUri, text: value.text, startOffset: value.startOffset, endOffset: value.endOffset, metadata: value.metadata ?? {}, createdAt: value.createdAt, updatedAt: value.updatedAt });
const evidence = (value: EvidenceDoc): Evidence => ({ id: value._id, edgeId: value.edgeId, documentId: value.documentId, sourceId: value.sourceId, chunkId: value.chunkId, sourceType: value.sourceType, extractor: value.extractor, confidence: value.confidence, direction: value.direction ?? "support", strength: value.strength, metadata: value.metadata ?? {}, createdAt: value.createdAt });

/** MongoDB property-graph adapter. It validates edge endpoints and explicitly cascades node deletion. */
export class MongoGraphStore implements GraphStore {
  private readonly nodes;
  private readonly edges;
  private readonly evidence;
  private readonly merges;
  constructor(db: Db) {
    this.nodes = db.collection<NodeDoc>("nodes");
    this.edges = db.collection<EdgeDoc>("edges");
    this.evidence = db.collection<EvidenceDoc>("evidence");
    this.merges = db.collection<NodeMergeDoc>("entity_merges");
    this.client = db.client;
  }
  private readonly client;
  async createNode(input: CreateNodeInput): Promise<GraphNode> {
    const now = new Date(); const value: NodeDoc = { _id: input.id ?? crypto.randomUUID(), scopeId: scopeId(input.scope), type: input.type, name: input.name, properties: input.properties ?? {}, embedding: input.embedding, createdAt: now, updatedAt: now };
    await this.nodes.insertOne(value); return node(value);
  }
  async getNode(id: NodeId, scope?: PlanetScope): Promise<GraphNode | null> { const value = await this.nodes.findOne({ _id: id, scopeId: scopeId(scope) }); return value ? node(value) : null; }
  async updateNode(id: NodeId, input: UpdateNodeInput): Promise<GraphNode | null> {
    const $set: Partial<NodeDoc> = { updatedAt: new Date() };
    if (input.type !== undefined) $set.type = input.type;
    if (input.name !== undefined) $set.name = input.name;
    if (input.properties !== undefined) $set.properties = input.properties;
    if (input.embedding !== undefined && input.embedding !== null) $set.embedding = input.embedding;
    const update: Document = { $set };
    if (input.embedding === null) update.$unset = { embedding: "" };
    await this.nodes.updateOne({ _id: id, scopeId: scopeId(input.scope) }, update); return this.getNode(id, input.scope);
  }
  async deleteNode(id: NodeId, scope?: PlanetScope): Promise<boolean> {
    // Delete dependent evidence before edges, then the node: no operation leaves dangling edges.
    const edgeIds = (await this.edges.find({ scopeId: scopeId(scope), $or: [{ sourceId: id }, { targetId: id }] }).project<{ _id: string }>({ _id: 1 }).toArray()).map((item) => item._id);
    if (edgeIds.length) { await this.evidence.deleteMany({ edgeId: { $in: edgeIds }, scopeId: scopeId(scope) }); await this.edges.deleteMany({ _id: { $in: edgeIds }, scopeId: scopeId(scope) }); }
    return (await this.nodes.deleteOne({ _id: id, scopeId: scopeId(scope) })).deletedCount === 1;
  }
  async mergeNodes(input: { sourceId: NodeId; targetId: NodeId; scope?: PlanetScope }): Promise<NodeMergeRecord> {
    if (input.sourceId === input.targetId) throw new Error("A node cannot be merged into itself.");
    const session = this.client.startSession(); const currentScope = scopeId(input.scope); const mergedAt = new Date();
    let audit: NodeMergeRecord | undefined;
    try {
      await session.withTransaction(async () => {
        const sourceNode = await this.nodes.findOne({ _id: input.sourceId, scopeId: currentScope }, { session });
        const targetNode = await this.nodes.findOne({ _id: input.targetId, scopeId: currentScope }, { session });
        if (!sourceNode || !targetNode) throw new Error("Both merge nodes must exist in this scope.");
        const sourceSnapshot = node(sourceNode); const targetBefore = node(targetNode);
        const sourceAliases = Array.isArray(sourceSnapshot.properties.aliases) ? sourceSnapshot.properties.aliases.filter((value): value is string => typeof value === "string") : [];
        const targetAliases = Array.isArray(targetBefore.properties.aliases) ? targetBefore.properties.aliases.filter((value): value is string => typeof value === "string") : [];
        const targetAfter: GraphNode = { ...targetBefore, properties: { ...targetBefore.properties, aliases: [...new Set([...targetAliases, sourceSnapshot.name, ...sourceAliases])] }, updatedAt: mergedAt };
        await this.nodes.updateOne({ _id: input.targetId, scopeId: currentScope }, { $set: { properties: targetAfter.properties, updatedAt: mergedAt } }, { session });
        const incident = await this.edges.find({ scopeId: currentScope, $or: [{ sourceId: input.sourceId }, { targetId: input.sourceId }] }, { session }).sort({ _id: 1 }).toArray();
        for (const candidate of incident) {
          const sourceId = candidate.sourceId === input.sourceId ? input.targetId : candidate.sourceId;
          const targetId = candidate.targetId === input.sourceId ? input.targetId : candidate.targetId;
          // Preserve parallel edges: their temporal ranges and evidence can represent distinct claims.
          await this.edges.updateOne({ _id: candidate._id, scopeId: currentScope }, { $set: { sourceId, targetId, updatedAt: mergedAt } }, { session });
        }
        await this.nodes.deleteOne({ _id: input.sourceId, scopeId: currentScope }, { session });
        await this.merges.updateOne({ scopeId: currentScope, sourceId: input.sourceId }, { $set: { targetId: input.targetId, mergedAt, source: sourceSnapshot, targetBefore, targetAfter } }, { upsert: true, session });
        audit = { sourceId: input.sourceId, targetId: input.targetId, mergedAt, source: sourceSnapshot, targetBefore, targetAfter };
      });
      if (!audit) throw new Error("MongoDB completed a merge transaction without an audit record.");
      return audit;
    } finally { await session.endSession(); }
  }
  async listMerges(input: { nodeId?: NodeId; limit?: number; scope?: PlanetScope }): Promise<NodeMergeRecord[]> {
    const filter: Filter<NodeMergeDoc> = { scopeId: scopeId(input.scope) };
    if (input.nodeId) filter.$or = [{ sourceId: input.nodeId }, { targetId: input.nodeId }];
    return (await this.merges.find(filter).sort({ mergedAt: -1, sourceId: 1 }).limit(Math.max(1, Math.min(input.limit ?? 100, 100000))).toArray()).map(({ sourceId, targetId, mergedAt, source, targetBefore, targetAfter }) => ({ sourceId, targetId, mergedAt, source, targetBefore, targetAfter }));
  }
  async listMergesPage(input: { nodeId?: NodeId; limit?: number; afterSourceId?: string; scope?: PlanetScope }): Promise<{ items: NodeMergeRecord[]; hasMore: boolean }> {
    const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
    const filter: Filter<NodeMergeDoc> = { scopeId: scopeId(input.scope) };
    if (input.nodeId) filter.$or = [{ sourceId: input.nodeId }, { targetId: input.nodeId }];
    if (input.afterSourceId) filter.sourceId = { $gt: input.afterSourceId };
    const rows = await this.merges.find(filter).sort({ sourceId: 1 }).limit(limit + 1).toArray();
    return { items: rows.slice(0, limit).map(({ sourceId, targetId, mergedAt, source, targetBefore, targetAfter }) => ({ sourceId, targetId, mergedAt, source, targetBefore, targetAfter })), hasMore: rows.length > limit };
  }
  async createEdge(input: CreateEdgeInput): Promise<GraphEdge> {
    const [from, to] = await Promise.all([this.nodes.countDocuments({ _id: input.from, scopeId: scopeId(input.scope) }, { limit: 1 }), this.nodes.countDocuments({ _id: input.to, scopeId: scopeId(input.scope) }, { limit: 1 })]);
    if (!from || !to) throw new Error("Cannot create an edge whose endpoint node does not exist.");
    if (input.validFrom && input.validTo && input.validTo <= input.validFrom) throw new Error("validTo must be later than validFrom.");
    const now = new Date(); const value: EdgeDoc = { _id: input.id ?? crypto.randomUUID(), scopeId: scopeId(input.scope), sourceId: input.from, targetId: input.to, relation: input.relation, properties: input.properties ?? {}, confidence: input.confidence, validFrom: input.validFrom, validTo: input.validTo, status: input.status ?? "candidate", createdAt: now, updatedAt: now };
    await this.edges.insertOne(value); return edge(value);
  }
  async getEdge(id: EdgeId, scope?: PlanetScope): Promise<GraphEdge | null> { const value = await this.edges.findOne({ _id: id, scopeId: scopeId(scope) }); return value ? edge(value) : null; }
  async updateEdge(id: EdgeId, input: UpdateEdgeInput): Promise<GraphEdge | null> { const fields: Partial<EdgeDoc> = { updatedAt: new Date() }; const unset: Record<string, ""> = {}; if (input.confidence !== undefined) fields.confidence = input.confidence; if (input.status !== undefined) fields.status = input.status; if (input.validFrom !== undefined) { if (input.validFrom === null) unset.validFrom = ""; else fields.validFrom = input.validFrom; } if (input.validTo !== undefined) { if (input.validTo === null) unset.validTo = ""; else fields.validTo = input.validTo; } if (input.properties !== undefined) fields.properties = input.properties; await this.edges.updateOne({ _id: id, scopeId: scopeId(input.scope) }, { $set: fields, ...(Object.keys(unset).length ? { $unset: unset } : {}) }); return this.getEdge(id, input.scope); }
  async deleteEdge(id: EdgeId, scope?: PlanetScope): Promise<boolean> { await this.evidence.deleteMany({ edgeId: id, scopeId: scopeId(scope) }); return (await this.edges.deleteOne({ _id: id, scopeId: scopeId(scope) })).deletedCount === 1; }
  async neighbors(input: NeighborsInput): Promise<GraphEdge[]> {
    const direction = input.direction ?? "both";
    const endpoint: Filter<EdgeDoc> = direction === "outbound" ? { sourceId: input.nodeId } : direction === "inbound" ? { targetId: input.nodeId } : { $or: [{ sourceId: input.nodeId }, { targetId: input.nodeId }] };
    const clauses: Filter<EdgeDoc>[] = [endpoint, { scopeId: scopeId(input.scope) }];
    if (input.relation) clauses.push({ relation: input.relation });
    if (input.asOf) clauses.push({ $and: [{ $or: [{ validFrom: { $exists: false } }, { validFrom: { $lte: input.asOf } }] }, { $or: [{ validTo: { $exists: false } }, { validTo: { $gt: input.asOf } }] }] });
    const filter: Filter<EdgeDoc> = { $and: clauses };
    return (await this.edges.find(filter).sort({ createdAt: 1, _id: 1 }).limit(input.limit ?? 100).toArray()).map(edge);
  }
  async traverse(input: TraverseInput): Promise<GraphTraversal> {
    const max = input.limit ?? 1000; const depths = new Map(input.startIds.map((id) => [id, 0])); const foundEdges = new Map<string, GraphEdge>(); let frontier = [...depths.keys()];
    for (let depth = 1; depth <= input.depth && frontier.length && depths.size < max; depth += 1) {
      const next: string[] = [];
      for (const id of frontier) for (const item of await this.neighbors({ nodeId: id, direction: input.direction, relation: input.relation, limit: max, scope: input.scope, asOf: input.asOf })) {
        foundEdges.set(item.id, item); const other = item.sourceId === id ? item.targetId : item.sourceId;
        if (!depths.has(other) && depths.size < max) { depths.set(other, depth); next.push(other); }
      }
      frontier = next;
    }
    const values = await this.nodes.find({ _id: { $in: [...depths.keys()] }, scopeId: scopeId(input.scope) }).toArray();
    return { nodes: values.map(node), edges: [...foundEdges.values()], depthByNode: Object.fromEntries(depths) };
  }
  async searchNodes(input: GraphTextSearchInput): Promise<GraphNode[]> {
    const escaped = input.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return (await this.nodes.find({ scopeId: scopeId(input.scope), name: { $regex: escaped, $options: "i" } }).sort({ name: 1, _id: 1 }).limit(input.limit ?? 20).toArray()).map(node);
  }
}

export class MongoDocumentStore implements DocumentStore {
  private readonly documents; private readonly chunks;
  constructor(db: Db) { this.documents = db.collection<SourceDoc>("documents"); this.chunks = db.collection<ChunkDoc>("document_chunks"); }
  async create(input: CreateDocumentInput): Promise<PlanetDocument> { const now = new Date(); const value: SourceDoc = { _id: input.id ?? crypto.randomUUID(), scopeId: scopeId(input.scope), externalId: input.externalId, title: input.title, contentUri: input.contentUri, metadata: input.metadata ?? {}, createdAt: now, updatedAt: now }; const { createdAt, ...updated } = value; await this.documents.updateOne({ _id: value._id, scopeId: value.scopeId }, { $set: { ...updated, updatedAt: now }, $setOnInsert: { createdAt } }, { upsert: true }); return source(value); }
  async get(id: DocumentId, scope?: PlanetScope): Promise<PlanetDocument | null> { const value = await this.documents.findOne({ _id: id, scopeId: scopeId(scope) }); return value ? source(value) : null; }
  async delete(id: DocumentId, scope?: PlanetScope): Promise<boolean> { const currentScope = scopeId(scope); await this.chunks.deleteMany({ documentId: id, scopeId: currentScope }); return (await this.documents.deleteOne({ _id: id, scopeId: currentScope })).deletedCount === 1; }
}

export class MongoDocumentChunkStore implements DocumentChunkStore {
  private readonly chunks; private readonly documents;
  constructor(db: Db) { this.chunks = db.collection<ChunkDoc>("document_chunks"); this.documents = db.collection<SourceDoc>("documents"); }
  async create(input: CreateDocumentChunkInput): Promise<DocumentChunk> { if (!input.text && !input.contentUri) throw new Error("A document chunk requires text or a content URI."); const currentScope = scopeId(input.scope); if (!await this.documents.countDocuments({ _id: input.documentId, scopeId: currentScope }, { limit: 1 })) throw new Error("A chunk requires an existing document in this scope."); const now = new Date(); const value: ChunkDoc = { _id: input.id ?? crypto.randomUUID(), scopeId: currentScope, documentId: input.documentId, contentUri: input.contentUri, text: input.text, startOffset: input.startOffset, endOffset: input.endOffset, metadata: input.metadata ?? {}, createdAt: now, updatedAt: now }; const { createdAt, ...updated } = value; await this.chunks.updateOne({ _id: value._id, scopeId: currentScope, documentId: input.documentId }, { $set: { ...updated, updatedAt: now }, $setOnInsert: { createdAt } }, { upsert: true }); return chunk(value); }
  async get(id: string, scope?: PlanetScope): Promise<DocumentChunk | null> { const value = await this.chunks.findOne({ _id: id, scopeId: scopeId(scope) }); return value ? chunk(value) : null; }
  async list(input: { documentId: string; limit?: number; scope?: PlanetScope }): Promise<DocumentChunk[]> { return (await this.chunks.find({ documentId: input.documentId, scopeId: scopeId(input.scope) }).sort({ startOffset: 1, _id: 1 }).limit(input.limit ?? 100).toArray()).map(chunk); }
  async listPage(input: { documentId: string; limit?: number; afterId?: string; scope?: PlanetScope }): Promise<{ items: DocumentChunk[]; hasMore: boolean }> { const limit = Math.max(1, Math.min(input.limit ?? 100, 500)); const filter: Filter<ChunkDoc> = { documentId: input.documentId, scopeId: scopeId(input.scope) }; if (input.afterId) filter._id = { $gt: input.afterId }; const rows = await this.chunks.find(filter).sort({ _id: 1 }).limit(limit + 1).toArray(); return { items: rows.slice(0, limit).map(chunk), hasMore: rows.length > limit }; }
  async search(input: { query: string; limit?: number; scope?: PlanetScope }): Promise<DocumentChunk[]> { const escaped = input.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); return (await this.chunks.find({ scopeId: scopeId(input.scope), text: { $regex: escaped, $options: "i" } }).sort({ _id: 1 }).limit(input.limit ?? 20).toArray()).map(chunk); }
  async searchPage(input: { query: string; limit?: number; afterId?: string; scope?: PlanetScope }): Promise<{ items: DocumentChunk[]; hasMore: boolean }> {
    const escaped = input.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const limit = Math.max(1, Math.min(input.limit ?? 20, 500));
    const filter: Filter<ChunkDoc> = { scopeId: scopeId(input.scope), text: { $regex: escaped, $options: "i" } };
    if (input.afterId) filter._id = { $gt: input.afterId };
    const rows = await this.chunks.find(filter).sort({ _id: 1 }).limit(limit + 1).toArray();
    return { items: rows.slice(0, limit).map(chunk), hasMore: rows.length > limit };
  }
  async deleteExcept(input: { documentId: string; keepIds: string[]; scope?: PlanetScope }): Promise<number> { const result = await this.chunks.deleteMany({ scopeId: scopeId(input.scope), documentId: input.documentId, _id: { $nin: input.keepIds } }); return result.deletedCount; }
}

export class MongoEvidenceStore implements EvidenceStore {
  private readonly evidence;
  private readonly edges;
  private readonly documents;
  constructor(db: Db) { this.evidence = db.collection<EvidenceDoc>("evidence"); this.edges = db.collection<EdgeDoc>("edges"); this.documents = db.collection<SourceDoc>("documents"); }
  async add(input: AddEvidenceInput): Promise<Evidence> {
    const [edgeCount, documentCount] = await Promise.all([this.edges.countDocuments({ _id: input.edgeId, scopeId: scopeId(input.scope) }, { limit: 1 }), input.documentId ? this.documents.countDocuments({ _id: input.documentId, scopeId: scopeId(input.scope) }, { limit: 1 }) : Promise.resolve(1)]);
    if (!edgeCount || !documentCount || (!input.documentId && !input.sourceId)) throw new Error("Evidence requires an existing edge and a document or source id.");
    const value: EvidenceDoc = { _id: input.id ?? crypto.randomUUID(), scopeId: scopeId(input.scope), edgeId: input.edgeId, documentId: input.documentId, sourceId: input.sourceId, chunkId: input.chunkId, sourceType: input.sourceType, extractor: input.extractor, confidence: input.confidence, direction: input.direction ?? "support", strength: input.strength ?? input.confidence, metadata: input.metadata ?? {}, createdAt: new Date() };
    await this.evidence.insertOne(value); return evidence(value);
  }
  async list(input: EvidenceListInput): Promise<Evidence[]> {
    const filter: Filter<EvidenceDoc> = { scopeId: scopeId(input.scope) };
    if (input.edgeId) filter.edgeId = input.edgeId;
    if (input.edgeIds?.length) filter.edgeId = { $in: input.edgeIds };
    if (input.documentId) filter.documentId = input.documentId;
    if (input.sourceId) filter.sourceId = input.sourceId;
    return (await this.evidence.find(filter).sort({ createdAt: 1, _id: 1 }).limit(input.limit ?? 100).toArray()).map(evidence);
  }
  async listPage(input: EvidenceListInput & { afterId?: string }): Promise<{ items: Evidence[]; hasMore: boolean }> {
    const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
    const filter: Filter<EvidenceDoc> = { scopeId: scopeId(input.scope) };
    if (input.edgeId) filter.edgeId = input.edgeId;
    if (input.edgeIds?.length) filter.edgeId = { $in: input.edgeIds };
    if (input.documentId) filter.documentId = input.documentId;
    if (input.sourceId) filter.sourceId = input.sourceId;
    if (input.afterId) filter._id = { $gt: input.afterId };
    const rows = await this.evidence.find(filter).sort({ _id: 1 }).limit(limit + 1).toArray();
    return { items: rows.slice(0, limit).map(evidence), hasMore: rows.length > limit };
  }
  async deleteByDocument(input: { documentId: string; scope?: PlanetScope }): Promise<number> { return (await this.evidence.deleteMany({ scopeId: scopeId(input.scope), documentId: input.documentId })).deletedCount ?? 0; }
  async deleteByChunks(input: { chunkIds: string[]; scope?: PlanetScope }): Promise<number> { if (!input.chunkIds.length) return 0; return (await this.evidence.deleteMany({ scopeId: scopeId(input.scope), chunkId: { $in: input.chunkIds } })).deletedCount ?? 0; }
}

/** Uses MongoDB Atlas Vector Search. Create an Atlas vector index for `embedding` before querying. */
export class MongoAtlasVectorStore implements VectorStore {
  private readonly vectors;
  constructor(db: Db, private readonly vectorIndex = "unknownplanet_vectors", private readonly collections: Readonly<Record<string, { dimensions: number; model?: string }>> = {}) { this.vectors = db.collection<VectorDoc>("vectors"); }
  private validate(namespace: string, embedding: number[], model?: string) { if (!embedding.length || embedding.some((number) => !Number.isFinite(number))) throw new Error("An embedding must contain finite numbers."); const collection = this.collections[namespace]; if (collection && collection.dimensions !== embedding.length) throw new EmbeddingDimensionMismatchError(collection.dimensions, embedding.length, model ?? collection.model ?? "unspecified", namespace); if (collection?.model && model && collection.model !== model) throw new Error(`Embedding model mismatch. Expected: ${collection.model}; received: ${model}; collection: ${namespace}.`); }
  async upsert(input: VectorRecord): Promise<void> { this.validate(input.namespace, input.embedding, input.model); const currentScope = scopeId(input.scope); await this.vectors.updateOne({ _id: `${currentScope}:${input.namespace}:${input.id}` }, { $set: { id: input.id, scopeId: currentScope, namespace: input.namespace, model: input.model ?? this.collections[input.namespace]?.model, embedding: input.embedding, metadata: input.metadata ?? {}, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } }, { upsert: true }); }
  async search(input: VectorSearchInput): Promise<VectorSearchResult[]> {
    if (input.namespace) this.validate(input.namespace, input.embedding, input.model);
    const limit = input.limit ?? 20; const vectorSearch: Document = { index: this.vectorIndex, path: "embedding", queryVector: input.embedding, numCandidates: Math.max(limit * 10, 100), limit };
    const metadataFilters: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input.metadata ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Unsupported vector metadata filter key '${key}'.`);
      metadataFilters[`metadata.${key}`] = value;
    }
    vectorSearch.filter = { ...(input.namespace ? { namespace: input.namespace } : {}), ...(input.model ? { model: input.model } : {}), scopeId: scopeId(input.scope), ...metadataFilters };
    const rows = await this.vectors.aggregate<{ id: string; namespace: string; metadata: JsonObject; score: number }>([{ $vectorSearch: vectorSearch }, { $project: { id: 1, namespace: 1, metadata: 1, score: { $meta: "vectorSearchScore" } } }]).toArray();
    return rows.map((row) => ({ id: row.id, namespace: row.namespace, metadata: row.metadata ?? {}, score: row.score }));
  }
  async delete(input: { id: string; namespace: string; scope?: PlanetScope }): Promise<void> { await this.vectors.deleteOne({ _id: `${scopeId(input.scope)}:${input.namespace}:${input.id}` }); }
}

export class MongoMemoryStore implements MemoryStore {
  private readonly memories;
  constructor(db: Db) { this.memories = db.collection<MemoryDoc>("memories"); }
  async add(input: AddMemoryInput): Promise<MemoryRecord> {
    const currentScope = scopeId(input.scope); const id = input.id ?? crypto.randomUUID(); const now = new Date();
    const value: MemoryDoc = { _id: id, scopeId: currentScope, agentId: input.agentId, userId: input.userId, sessionId: input.sessionId, content: input.content, type: input.type ?? "fact", importance: input.importance, confidence: input.confidence, source: input.source, metadata: input.metadata ?? {}, createdAt: now, updatedAt: now };
    const { createdAt, ...updated } = value;
    await this.memories.updateOne({ _id: id, scopeId: currentScope }, { $set: updated, $setOnInsert: { createdAt } }, { upsert: true });
    const record = await this.get(id, input.scope);
    if (!record) throw new Error("Memory upsert did not persist a record.");
    return record;
  }
  async get(id: string, scope?: PlanetScope): Promise<MemoryRecord | null> { const value = await this.memories.findOne({ _id: id, scopeId: scopeId(scope) }); return value ? this.toMemory(value) : null; }
  async search(input: MemorySearchInput): Promise<MemoryRecord[]> {
    const filter: Filter<MemoryDoc> = { scopeId: scopeId(input.scope) };
    if (input.agentId) filter.agentId = input.agentId;
    if (input.userId) filter.userId = input.userId;
    if (input.sessionId) filter.sessionId = input.sessionId;
    if (input.type) filter.type = input.type;
    if (input.query?.trim()) filter.content = { $regex: input.query.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
    const rows = await this.memories.find(filter).sort({ createdAt: -1, _id: 1 }).limit(input.limit ?? 20).toArray();
    return rows.filter((row) => !input.metadata || Object.entries(input.metadata).every(([key, value]) => row.metadata?.[key] === value)).map((row) => this.toMemory(row));
  }
  async searchPage(input: MemorySearchInput & { afterId?: string }): Promise<{ items: MemoryRecord[]; hasMore: boolean }> {
    const filter: Filter<MemoryDoc> = { scopeId: scopeId(input.scope) };
    if (input.agentId) filter.agentId = input.agentId;
    if (input.userId) filter.userId = input.userId;
    if (input.sessionId) filter.sessionId = input.sessionId;
    if (input.type) filter.type = input.type;
    if (input.afterId) filter._id = { $gt: input.afterId };
    if (input.query?.trim()) filter.content = { $regex: input.query.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
    for (const [key, value] of Object.entries(input.metadata ?? {})) (filter as Record<string, unknown>)[`metadata.${key}`] = value;
    const limit = Math.max(1, Math.min(input.limit ?? 20, 500));
    const rows = await this.memories.find(filter).sort({ _id: 1 }).limit(limit + 1).toArray();
    return { items: rows.slice(0, limit).map((row) => this.toMemory(row)), hasMore: rows.length > limit };
  }
  async delete(id: string, scope?: PlanetScope): Promise<boolean> { return (await this.memories.deleteOne({ _id: id, scopeId: scopeId(scope) })).deletedCount === 1; }
  private toMemory(value: MemoryDoc): MemoryRecord { return { id: value._id, agentId: value.agentId, userId: value.userId, sessionId: value.sessionId, content: value.content, type: value.type, importance: value.importance, confidence: value.confidence, source: value.source, metadata: value.metadata ?? {}, createdAt: value.createdAt, updatedAt: value.updatedAt }; }
}

const toIngestionJob = (value: IngestionJobDoc): IngestionJob => ({ id: value._id, kind: value.kind, status: value.status, checkpoint: value.checkpoint, attempts: value.attempts, maxAttempts: value.maxAttempts, input: value.input ?? {}, nextAttemptAt: value.nextAttemptAt, leaseUntil: value.leaseUntil, leaseToken: value.leaseToken, lastError: value.lastError, createdAt: value.createdAt, updatedAt: value.updatedAt });
export class MongoIngestionJobStore implements IngestionJobStore {
  private readonly jobs;
  constructor(db: Db) { this.jobs = db.collection<IngestionJobDoc>("ingestion_jobs"); }
  async create(input: CreateIngestionJobInput): Promise<IngestionJob> {
    const currentScope = scopeId(input.scope); const now = new Date();
    const value: IngestionJobDoc = { _id: input.id, scopeId: currentScope, kind: input.kind, status: "queued", checkpoint: "queued", attempts: 0, maxAttempts: input.maxAttempts ?? 5, input: input.input, nextAttemptAt: now, createdAt: now, updatedAt: now };
    const update = { scopeId: currentScope, kind: value.kind, status: value.status, checkpoint: value.checkpoint, attempts: value.attempts, maxAttempts: value.maxAttempts, input: value.input, nextAttemptAt: value.nextAttemptAt, updatedAt: value.updatedAt };
    const reset = await this.jobs.updateOne({ _id: input.id, scopeId: currentScope, status: { $in: ["succeeded", "failed"] } }, { $set: update, $unset: { leaseUntil: "", leaseToken: "", lastError: "" } });
    if (!reset.matchedCount) {
      try { await this.jobs.insertOne(value); }
      catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === 11000)) throw error; }
    }
    const result = await this.get(input.id, input.scope); if (!result) throw new Error("Ingestion job upsert did not persist a record."); return result;
  }
  async get(id: string, scope?: PlanetScope): Promise<IngestionJob | null> { const value = await this.jobs.findOne({ _id: id, scopeId: scopeId(scope) }); return value ? toIngestionJob(value) : null; }
  async update(input: UpdateIngestionJobInput): Promise<IngestionJob> {
    const $set: Partial<IngestionJobDoc> = { updatedAt: new Date() }; const $unset: Record<string, ""> = {};
    if (input.status !== undefined) $set.status = input.status;
    if (input.checkpoint !== undefined) $set.checkpoint = input.checkpoint;
    if (input.attempts !== undefined) $set.attempts = input.attempts;
    if (input.input !== undefined) $set.input = input.input;
    if (input.nextAttemptAt !== undefined) { if (input.nextAttemptAt === null) $unset.nextAttemptAt = ""; else $set.nextAttemptAt = input.nextAttemptAt; }
    if (input.leaseUntil !== undefined) { if (input.leaseUntil === null) $unset.leaseUntil = ""; else $set.leaseUntil = input.leaseUntil; }
    if (input.leaseToken !== undefined) { if (input.leaseToken === null) $unset.leaseToken = ""; else $set.leaseToken = input.leaseToken; }
    if (input.lastError !== undefined) { if (input.lastError === null) $unset.lastError = ""; else $set.lastError = input.lastError; }
    const filter: Filter<IngestionJobDoc> = { _id: input.id, scopeId: scopeId(input.scope) };
    if (input.expectedLeaseToken !== undefined) { filter.status = "processing"; filter.leaseToken = input.expectedLeaseToken; filter.leaseUntil = { $gt: new Date() }; }
    else filter.status = { $ne: "processing" };
    const changed = await this.jobs.updateOne(filter, { $set, ...(Object.keys($unset).length ? { $unset } : {}) });
    if (!changed.matchedCount) throw new Error("Ingestion job does not exist or its lease is no longer owned by this worker.");
    const result = await this.get(input.id, input.scope); if (!result) throw new Error("Ingestion job does not exist in this scope."); return result;
  }
  async claim(input: { id: string; leaseMs?: number; scope?: PlanetScope }): Promise<IngestionJob> {
    const now = new Date();
    const job = await this.jobs.findOneAndUpdate({ _id: input.id, scopeId: scopeId(input.scope), $expr: { $lt: ["$attempts", "$maxAttempts"] }, $or: [{ status: { $in: ["queued", "retry_wait"] }, nextAttemptAt: { $lte: now } }, { status: "processing", leaseUntil: { $lte: now } }] }, { $set: { status: "processing", leaseUntil: new Date(now.getTime() + Math.max(1000, input.leaseMs ?? 60_000)), leaseToken: crypto.randomUUID(), updatedAt: now }, $inc: { attempts: 1 } }, { returnDocument: "after", includeResultMetadata: false });
    if (!job) throw new Error("Ingestion job is not available for claim.");
    return toIngestionJob(job);
  }
  async claimDue(input: { now?: Date; limit?: number; leaseMs?: number; scope?: PlanetScope }): Promise<IngestionJob[]> {
    const now = input.now ?? new Date(); const leaseUntil = new Date(now.getTime() + Math.max(1000, input.leaseMs ?? 60_000)); const jobs: IngestionJob[] = [];
    const limit = Math.max(1, Math.min(input.limit ?? 10, 100));
    await this.jobs.updateMany({ scopeId: scopeId(input.scope), $expr: { $gte: ["$attempts", "$maxAttempts"] }, $or: [{ status: "retry_wait", nextAttemptAt: { $lte: now } }, { status: "processing", leaseUntil: { $lte: now } }] }, { $set: { status: "failed", lastError: "Retry limit exceeded.", updatedAt: now }, $unset: { leaseUntil: "", leaseToken: "" } });
    for (let index = 0; index < limit; index += 1) {
      const job = await this.jobs.findOneAndUpdate({ scopeId: scopeId(input.scope), $expr: { $lt: ["$attempts", "$maxAttempts"] }, $or: [{ status: { $in: ["queued", "retry_wait"] }, nextAttemptAt: { $lte: now } }, { status: "processing", leaseUntil: { $lte: now } }] }, { $set: { status: "processing", leaseUntil, leaseToken: crypto.randomUUID(), updatedAt: now }, $inc: { attempts: 1 } }, { sort: { nextAttemptAt: 1, _id: 1 }, returnDocument: "after", includeResultMetadata: false });
      if (!job) break;
      jobs.push(toIngestionJob(job));
    }
    return jobs;
  }
}

const assertNamedStoreKey = (value: string, label: string) => { if (!value.trim()) throw new Error(`${label} cannot be empty.`); };
const queueMessage = (value: QueueDoc): QueueMessage => ({ id: value._id, queue: value.queue, value: value.value, attempts: value.attempts, availableAt: value.availableAt });
export class MongoQueueStore implements QueueStore {
  private readonly messages;
  constructor(db: Db) { this.messages = db.collection<QueueDoc>("queue_messages"); }
  async enqueue(input: { queue: string; value: JsonValue; delayMs?: number; scope?: PlanetScope }): Promise<QueueMessage> {
    assertNamedStoreKey(input.queue, "Queue name"); const delay = input.delayMs ?? 0; if (!Number.isFinite(delay) || delay < 0) throw new Error("Queue delayMs must be a non-negative number.");
    const now = new Date(); const value: QueueDoc = { _id: crypto.randomUUID(), scopeId: scopeId(input.scope), queue: input.queue, value: input.value, status: "ready", attempts: 0, availableAt: new Date(now.getTime() + delay), createdAt: now }; await this.messages.insertOne(value); return queueMessage(value);
  }
  async claim(input: { queue: string; limit?: number; leaseMs?: number; scope?: PlanetScope }): Promise<ClaimedQueueMessage[]> {
    assertNamedStoreKey(input.queue, "Queue name"); const rawLimit = input.limit ?? 1; const leaseMs = input.leaseMs ?? 60_000; if (!Number.isFinite(rawLimit) || !Number.isFinite(leaseMs)) throw new Error("Queue limit and leaseMs must be finite numbers."); const limit = Math.max(1, Math.min(Math.floor(rawLimit), 100)); const now = new Date(); const claimed: ClaimedQueueMessage[] = [];
    for (let index = 0; index < limit; index += 1) { const value = await this.messages.findOneAndUpdate({ scopeId: scopeId(input.scope), queue: input.queue, $or: [{ status: "ready", availableAt: { $lte: now } }, { status: "leased", availableAt: { $lte: now }, leaseUntil: { $lte: now } }] }, { $set: { status: "leased", leaseUntil: new Date(now.getTime() + Math.max(1000, leaseMs)), leaseToken: crypto.randomUUID() }, $inc: { attempts: 1 } }, { sort: { availableAt: 1, _id: 1 }, returnDocument: "after", includeResultMetadata: false }); if (!value) break; if (!value.leaseToken || !value.leaseUntil) throw new Error("MongoDB returned a queue claim without a lease."); claimed.push({ ...queueMessage(value), leaseToken: value.leaseToken, leaseUntil: value.leaseUntil }); }
    return claimed;
  }
  async ack(input: { queue: string; id: string; leaseToken: string; scope?: PlanetScope }): Promise<boolean> { return (await this.messages.deleteOne({ _id: input.id, scopeId: scopeId(input.scope), queue: input.queue, status: "leased", leaseToken: input.leaseToken, leaseUntil: { $gt: new Date() } })).deletedCount === 1; }
  async release(input: { queue: string; id: string; leaseToken: string; delayMs?: number; scope?: PlanetScope }): Promise<boolean> { const delay = input.delayMs ?? 0; if (!Number.isFinite(delay) || delay < 0) throw new Error("Queue delayMs must be a non-negative number."); const result = await this.messages.updateOne({ _id: input.id, scopeId: scopeId(input.scope), queue: input.queue, status: "leased", leaseToken: input.leaseToken, leaseUntil: { $gt: new Date() } }, { $set: { status: "ready", availableAt: new Date(Date.now() + delay) }, $unset: { leaseUntil: "", leaseToken: "" } }); return result.modifiedCount === 1; }
}
export class MongoStackStore implements StackStore {
  private readonly entries;
  private readonly counters;
  constructor(db: Db) { this.entries = db.collection<StackEntryDoc>("stack_entries"); this.counters = db.collection<StackCounterDoc>("stack_counters"); }
  async push(input: { stack: string; value: JsonValue; scope?: PlanetScope }): Promise<void> { assertNamedStoreKey(input.stack, "Stack name"); const currentScope = scopeId(input.scope); const counter = await this.counters.findOneAndUpdate({ scopeId: currentScope, stack: input.stack }, { $inc: { sequence: 1 } }, { upsert: true, returnDocument: "after", includeResultMetadata: false }); if (!counter) throw new Error("Stack sequence allocation failed."); await this.entries.insertOne({ _id: crypto.randomUUID(), scopeId: currentScope, stack: input.stack, sequence: counter.sequence, value: input.value, createdAt: new Date() }); }
  async pop(input: { stack: string; scope?: PlanetScope }): Promise<JsonValue | null> { assertNamedStoreKey(input.stack, "Stack name"); const value = await this.entries.findOneAndDelete({ scopeId: scopeId(input.scope), stack: input.stack }, { sort: { sequence: -1 } }); return value?.value ?? null; }
  async peek(input: { stack: string; scope?: PlanetScope }): Promise<JsonValue | null> { assertNamedStoreKey(input.stack, "Stack name"); const value = await this.entries.find({ scopeId: scopeId(input.scope), stack: input.stack }).sort({ sequence: -1 }).limit(1).next(); return value?.value ?? null; }
  async size(input: { stack: string; scope?: PlanetScope }): Promise<number> { assertNamedStoreKey(input.stack, "Stack name"); return this.entries.countDocuments({ scopeId: scopeId(input.scope), stack: input.stack }); }
}
export class MongoKeyValueStore implements KeyValueStore {
  private readonly values;
  constructor(db: Db) { this.values = db.collection<KeyValueDoc>("key_values"); }
  async get(input: { namespace?: string; key: string; scope?: PlanetScope }): Promise<{ value: JsonValue; expiresAt?: Date } | null> { assertNamedStoreKey(input.key, "Key"); const value = await this.values.findOne({ scopeId: scopeId(input.scope), namespace: input.namespace ?? "default", key: input.key, $or: [{ expiresAt: { $exists: false } }, { expiresAt: { $gt: new Date() } }] }); return value ? { value: value.value, expiresAt: value.expiresAt } : null; }
  async set(input: { namespace?: string; key: string; value: JsonValue; ttlMs?: number; scope?: PlanetScope }): Promise<void> { assertNamedStoreKey(input.key, "Key"); const ttl = input.ttlMs; if (ttl !== undefined && (!Number.isFinite(ttl) || ttl < 0)) throw new Error("Key/value ttlMs must be a non-negative number."); const now = new Date(); const document: KeyValueDoc = { scopeId: scopeId(input.scope), namespace: input.namespace ?? "default", key: input.key, value: input.value, ...(ttl === undefined ? {} : { expiresAt: new Date(now.getTime() + ttl) }), updatedAt: now }; await this.values.replaceOne({ scopeId: document.scopeId, namespace: document.namespace, key: document.key }, document, { upsert: true }); }
  async delete(input: { namespace?: string; key: string; scope?: PlanetScope }): Promise<boolean> { assertNamedStoreKey(input.key, "Key"); return (await this.values.deleteOne({ scopeId: scopeId(input.scope), namespace: input.namespace ?? "default", key: input.key })).deletedCount === 1; }
}

const mongoFeatureCollections: Record<string, string> = {
  nodes: "graph", edges: "graph", entity_merges: "graph", vectors: "vector", documents: "documents", document_chunks: "chunks", evidence: "evidence", memories: "memories", ingestion_jobs: "ingestionJobs", queue_messages: "queue", stack_entries: "stack", stack_counters: "stack", key_values: "keyValue",
};
function schemaMongoDatabase(db: Db, schemas: ProviderSchemaMap = {}): Db {
  const prefixes = Object.fromEntries(Object.entries(schemas).filter(([feature]) => Object.values(mongoFeatureCollections).includes(feature)));
  for (const [feature, prefix] of Object.entries(prefixes)) if (!prefix || !/^[A-Za-z0-9_-]+$/.test(prefix)) throw new Error(`MongoDB ${feature} namespace must contain only letters, numbers, underscores, or hyphens.`);
  return new Proxy(db, { get(target, property, receiver) {
    if (property === "collection") return (name: string) => {
      const feature = mongoFeatureCollections[name]; const prefix = feature ? prefixes[feature] as string | undefined : undefined;
      return target.collection(prefix ? `${prefix}_${name}` : name);
    };
    return Reflect.get(target, property, receiver) as unknown;
  } });
}

export class MongoCollectionStore implements CollectionStore {
  private readonly allowed: ReadonlySet<string>;
  constructor(private readonly db: Db, collections: readonly string[]) {
    if (collections.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) throw new Error("Custom collection names must be simple identifiers.");
    if (collections.some((name) => Object.hasOwn(mongoFeatureCollections, name) || name === "unknownplanet_scope_key_map")) throw new Error("Planet-managed collections cannot be registered as custom collections.");
    this.allowed = new Set(collections);
  }
  private collection(name: string) {
    if (!this.allowed.has(name)) throw new Error(`Custom collection '${name}' is not registered.`);
    return this.db.collection(name);
  }
  async find<T extends Record<string, unknown> = Record<string, unknown>>(input: { collection: string; filter?: Record<string, unknown>; limit?: number }): Promise<T[]> {
    const limit = input.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("Custom collection find limit must be between 1 and 1000.");
    return await this.collection(input.collection).find(input.filter ?? {}).limit(limit).toArray() as unknown as T[];
  }
  async insertOne(input: { collection: string; document: Record<string, unknown> }): Promise<{ insertedId: unknown }> {
    const result = await this.collection(input.collection).insertOne(input.document);
    return { insertedId: result.insertedId };
  }
  async updateOne(input: { collection: string; filter: Record<string, unknown>; update: Record<string, unknown> }): Promise<{ matchedCount: number; modifiedCount: number }> {
    if (!Object.keys(input.filter).length) throw new Error("Custom collection update requires a non-empty filter.");
    const result = await this.collection(input.collection).updateOne(input.filter, input.update);
    return { matchedCount: result.matchedCount, modifiedCount: result.modifiedCount };
  }
  async deleteOne(input: { collection: string; filter: Record<string, unknown> }): Promise<{ deletedCount: number }> {
    if (!Object.keys(input.filter).length) throw new Error("Custom collection delete requires a non-empty filter.");
    const result = await this.collection(input.collection).deleteOne(input.filter);
    return { deletedCount: result.deletedCount };
  }
}

export function createMongoProvider(input: { id?: string; database: Db; vectorIndex?: string; vectorCollections?: Record<string, { dimensions: number; model?: string }>; schemas?: ProviderSchemaMap; customCollections?: readonly string[] }): DataLayerProvider {
  const database = schemaMongoDatabase(input.database, input.schemas);
  return { id: input.id ?? "mongodb", graph: new MongoGraphStore(database), documents: new MongoDocumentStore(database), chunks: new MongoDocumentChunkStore(database), evidence: new MongoEvidenceStore(database), memories: new MongoMemoryStore(database), ingestionJobs: new MongoIngestionJobStore(database), queue: new MongoQueueStore(database), stack: new MongoStackStore(database), keyValue: new MongoKeyValueStore(database), vector: new MongoAtlasVectorStore(database, input.vectorIndex, input.vectorCollections), vectorCollections: input.vectorCollections, collections: input.customCollections?.length ? new MongoCollectionStore(input.database, input.customCollections) : undefined };
}

/** Migrate Planet-owned collections before deploying the v2 scope-key readers. Stop writers first. */
export async function migrateMongoScopeKeys(db: Db, mappings: Readonly<Record<string, PlanetScope>>, schemas: ProviderSchemaMap = {}): Promise<void> {
  const database = schemaMongoDatabase(db, schemas);
  const collections = Object.keys(mongoFeatureCollections).map((name) => database.collection(name));
  const migrationMap = db.collection<{ _id: string; newKey: string }>("unknownplanet_scope_key_map");
  const recorded = await migrationMap.find().toArray();
  const knownDestinations = new Set(recorded.map((item) => item.newKey));
  const recordedByOldKey = new Map(recorded.map((item) => [item._id, item.newKey]));
  const oldKeys = new Set<string>();
  for (const collection of collections) {
    for (const key of await collection.distinct<string>("scopeId")) if (typeof key === "string") oldKeys.add(key);
  }
  const changes = new Map<string, string>();
  const destinations = new Map<string, string>(recorded.map((item) => [item.newKey, item._id]));
  for (const oldKey of oldKeys) {
    if (knownDestinations.has(oldKey)) continue;
    const recordedNext = recordedByOldKey.get(oldKey);
    const mapped = Object.hasOwn(mappings, oldKey) ? mappings[oldKey] : undefined;
    if (!recordedNext && !mapped && oldKey.includes(":")) throw new Error(`Ambiguous legacy scope key '${oldKey}'. Supply its tenant/workspace mapping before migrating.`);
    const next = recordedNext ?? scopeStorageKey(mapped ?? { tenantId: oldKey });
    if (recordedNext && mapped && recordedNext !== scopeStorageKey(mapped)) throw new Error(`Legacy scope key '${oldKey}' was previously mapped to a different destination.`);
    const prior = destinations.get(next);
    if (prior && prior !== oldKey) throw new Error(`Legacy scope keys '${prior}' and '${oldKey}' map to the same destination.`);
    destinations.set(next, oldKey);
    if (next !== oldKey) changes.set(oldKey, next);
  }
  for (const [oldKey, next] of changes) await migrationMap.updateOne({ _id: oldKey }, { $setOnInsert: { newKey: next } }, { upsert: true });
  for (const collection of collections.filter((item) => item.collectionName !== database.collection("vectors").collectionName)) {
    for (const [oldKey, next] of changes) await collection.updateMany({ scopeId: oldKey }, { $set: { scopeId: next } });
  }
  const vectors = database.collection<VectorDoc>("vectors");
  for (const [oldKey, next] of changes) {
    for await (const vector of vectors.find({ scopeId: oldKey })) {
      const session = db.client.startSession();
      try {
        await session.withTransaction(async () => {
          await vectors.insertOne({ ...vector, _id: `${next}:${vector.namespace}:${vector.id}`, scopeId: next }, { session });
          await vectors.deleteOne({ _id: vector._id, scopeId: oldKey }, { session });
        });
      } finally { await session.endSession(); }
    }
  }
}

/** Create the compound indexes used by the Mongo adapters. Atlas vector search index definitions remain managed by Atlas. */
export async function initializeMongoIndexes(db: Db, schemas: ProviderSchemaMap = {}): Promise<void> {
  db = schemaMongoDatabase(db, schemas);
  await Promise.all([
    db.collection("nodes").createIndex({ scopeId: 1, name: 1 }, { name: "planet_nodes_scope_name" }),
    db.collection("edges").createIndex({ scopeId: 1, sourceId: 1, relation: 1 }, { name: "planet_edges_scope_source" }),
    db.collection("edges").createIndex({ scopeId: 1, targetId: 1, relation: 1 }, { name: "planet_edges_scope_target" }),
    db.collection("documents").createIndex({ scopeId: 1, externalId: 1 }, { name: "planet_documents_scope_external", unique: true, partialFilterExpression: { externalId: { $type: "string" } } }),
    db.collection("document_chunks").createIndex({ scopeId: 1, documentId: 1, startOffset: 1 }, { name: "planet_chunks_scope_document_offset" }),
    db.collection("document_chunks").createIndex({ scopeId: 1, text: "text" }, { name: "planet_chunks_text" }),
    db.collection("evidence").createIndex({ scopeId: 1, edgeId: 1, createdAt: 1 }, { name: "planet_evidence_scope_edge" }),
    db.collection("evidence").createIndex({ scopeId: 1, sourceId: 1 }, { name: "planet_evidence_scope_source" }),
    db.collection("memories").createIndex({ scopeId: 1, agentId: 1, userId: 1, sessionId: 1, createdAt: -1 }, { name: "planet_memories_owner" }),
    db.collection("memories").createIndex({ scopeId: 1, content: "text" }, { name: "planet_memories_text" }),
    db.collection("vectors").createIndex({ scopeId: 1, namespace: 1, id: 1 }, { name: "planet_vectors_scope_namespace_id", unique: true }),
    db.collection("entity_merges").createIndex({ scopeId: 1, sourceId: 1 }, { name: "planet_entity_merges_scope_source", unique: true }),
    db.collection("entity_merges").createIndex({ scopeId: 1, targetId: 1, mergedAt: -1 }, { name: "planet_entity_merges_scope_target" }),
    db.collection("ingestion_jobs").createIndex({ scopeId: 1, status: 1, nextAttemptAt: 1, _id: 1 }, { name: "planet_ingestion_jobs_due" }),
    db.collection("queue_messages").createIndex({ scopeId: 1, queue: 1, status: 1, availableAt: 1, _id: 1 }, { name: "planet_queue_claim" }),
    db.collection("stack_counters").createIndex({ scopeId: 1, stack: 1 }, { name: "planet_stack_counter", unique: true }),
    db.collection("stack_entries").createIndex({ scopeId: 1, stack: 1, sequence: -1 }, { name: "planet_stack_order", unique: true }),
    db.collection("key_values").createIndex({ scopeId: 1, namespace: 1, key: 1 }, { name: "planet_key_value_key", unique: true }),
    db.collection("key_values").createIndex({ expiresAt: 1 }, { name: "planet_key_value_expiry", expireAfterSeconds: 0, partialFilterExpression: { expiresAt: { $type: "date" } } }),
  ]);
}
