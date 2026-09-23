import type { Db, Document, Filter } from "mongodb";
import type {
  AddEvidenceInput, AddMemoryInput, CreateDocumentChunkInput, CreateDocumentInput, CreateEdgeInput, CreateNodeInput, DataLayerProvider,
  CreateIngestionJobInput, DocumentChunk, DocumentChunkStore, DocumentId, DocumentStore, EdgeId, Evidence, EvidenceListInput, EvidenceStore, GraphEdge, IngestionJob, IngestionJobStore,
  GraphNode, GraphStore, GraphTextSearchInput, GraphTraversal, JsonObject, MemoryRecord, MemorySearchInput, MemoryStore, NeighborsInput, NodeId, NodeMergeRecord, PlanetDocument,
  PlanetScope, TraverseInput, UpdateEdgeInput, UpdateIngestionJobInput, UpdateNodeInput, VectorRecord, VectorSearchInput, VectorSearchResult, VectorStore,
} from "@unknown-planet/core";

interface NodeDoc extends Document { _id: string; scopeId: string; type: string; name: string; properties: JsonObject; embedding?: number[]; createdAt: Date; updatedAt: Date }
interface EdgeDoc extends Document { _id: string; scopeId: string; sourceId: string; targetId: string; relation: string; properties: JsonObject; confidence?: number; validFrom?: Date; validTo?: Date; status?: GraphEdge["status"]; createdAt: Date; updatedAt: Date }
interface SourceDoc extends Document { _id: string; scopeId: string; externalId?: string; title: string; contentUri: string; metadata: JsonObject; createdAt: Date; updatedAt: Date }
interface ChunkDoc extends Document { _id: string; scopeId: string; documentId: string; contentUri?: string; text?: string; startOffset?: number; endOffset?: number; metadata: JsonObject; createdAt: Date; updatedAt: Date }
interface EvidenceDoc extends Document { _id: string; scopeId: string; edgeId: string; documentId?: string; sourceId?: string; chunkId?: string; sourceType?: string; extractor: string; confidence?: number; direction?: Evidence["direction"]; strength?: number; metadata: JsonObject; createdAt: Date }
interface MemoryDoc extends Document { _id: string; scopeId: string; agentId: string; userId?: string; sessionId?: string; content: string; type: MemoryRecord["type"]; importance?: number; confidence?: number; source?: MemoryRecord["source"]; metadata: JsonObject; createdAt: Date; updatedAt: Date }
interface VectorDoc extends Document { _id: string; id: string; scopeId: string; namespace: string; model?: string; embedding: number[]; metadata: JsonObject; createdAt: Date; updatedAt: Date }
interface NodeMergeDoc extends Document { scopeId: string; sourceId: string; targetId: string; mergedAt: Date; source: GraphNode; targetBefore: GraphNode; targetAfter: GraphNode }
interface IngestionJobDoc extends Document { _id: string; scopeId: string; kind: IngestionJob["kind"]; status: IngestionJob["status"]; checkpoint: IngestionJob["checkpoint"]; attempts: number; maxAttempts: number; input: JsonObject; nextAttemptAt: Date; leaseUntil?: Date; lastError?: string; createdAt: Date; updatedAt: Date }
const scopeId = (scope?: PlanetScope) => scope?.workspaceId ? `${scope.tenantId}:${scope.workspaceId}` : (scope?.tenantId ?? "default");

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
  async deleteByDocument(input: { documentId: string; scope?: PlanetScope }): Promise<number> { return (await this.evidence.deleteMany({ scopeId: scopeId(input.scope), documentId: input.documentId })).deletedCount ?? 0; }
}

/** Uses MongoDB Atlas Vector Search. Create an Atlas vector index for `embedding` before querying. */
export class MongoAtlasVectorStore implements VectorStore {
  private readonly vectors;
  constructor(db: Db, private readonly vectorIndex = "unknownplanet_vectors", private readonly collections: Readonly<Record<string, { dimensions: number; model?: string }>> = {}) { this.vectors = db.collection<VectorDoc>("vectors"); }
  private validate(namespace: string, embedding: number[], model?: string) { if (!embedding.length || embedding.some((number) => !Number.isFinite(number))) throw new Error("An embedding must contain finite numbers."); const collection = this.collections[namespace]; if (collection && collection.dimensions !== embedding.length) throw new Error(`Vector namespace '${namespace}' requires ${collection.dimensions} dimensions.`); if (collection?.model && model && collection.model !== model) throw new Error(`Vector namespace '${namespace}' requires model '${collection.model}'.`); }
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
    if (input.query?.trim()) filter.content = { $regex: input.query.trim().replace(/[.*+?^${}()|[\\]\\]/g, "\\$&"), $options: "i" };
    for (const [key, value] of Object.entries(input.metadata ?? {})) (filter as Record<string, unknown>)[`metadata.${key}`] = value;
    const limit = Math.max(1, Math.min(input.limit ?? 20, 500));
    const rows = await this.memories.find(filter).sort({ _id: 1 }).limit(limit + 1).toArray();
    return { items: rows.slice(0, limit).map((row) => this.toMemory(row)), hasMore: rows.length > limit };
  }
  async delete(id: string, scope?: PlanetScope): Promise<boolean> { return (await this.memories.deleteOne({ _id: id, scopeId: scopeId(scope) })).deletedCount === 1; }
  private toMemory(value: MemoryDoc): MemoryRecord { return { id: value._id, agentId: value.agentId, userId: value.userId, sessionId: value.sessionId, content: value.content, type: value.type, importance: value.importance, confidence: value.confidence, source: value.source, metadata: value.metadata ?? {}, createdAt: value.createdAt, updatedAt: value.updatedAt }; }
}

const toIngestionJob = (value: IngestionJobDoc): IngestionJob => ({ id: value._id, kind: value.kind, status: value.status, checkpoint: value.checkpoint, attempts: value.attempts, maxAttempts: value.maxAttempts, input: value.input ?? {}, nextAttemptAt: value.nextAttemptAt, leaseUntil: value.leaseUntil, lastError: value.lastError, createdAt: value.createdAt, updatedAt: value.updatedAt });
export class MongoIngestionJobStore implements IngestionJobStore {
  private readonly jobs;
  constructor(db: Db) { this.jobs = db.collection<IngestionJobDoc>("ingestion_jobs"); }
  async create(input: CreateIngestionJobInput): Promise<IngestionJob> {
    const currentScope = scopeId(input.scope); const now = new Date();
    const value: IngestionJobDoc = { _id: input.id, scopeId: currentScope, kind: input.kind, status: "queued", checkpoint: "queued", attempts: 0, maxAttempts: input.maxAttempts ?? 5, input: input.input, nextAttemptAt: now, createdAt: now, updatedAt: now };
    const update = { scopeId: currentScope, kind: value.kind, status: value.status, checkpoint: value.checkpoint, attempts: value.attempts, maxAttempts: value.maxAttempts, input: value.input, nextAttemptAt: value.nextAttemptAt, updatedAt: value.updatedAt };
    await this.jobs.updateOne({ _id: input.id, scopeId: currentScope }, { $set: { ...update, updatedAt: now }, $setOnInsert: { createdAt: now } }, { upsert: true });
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
    if (input.lastError !== undefined) { if (input.lastError === null) $unset.lastError = ""; else $set.lastError = input.lastError; }
    await this.jobs.updateOne({ _id: input.id, scopeId: scopeId(input.scope) }, { $set, ...(Object.keys($unset).length ? { $unset } : {}) });
    const result = await this.get(input.id, input.scope); if (!result) throw new Error("Ingestion job does not exist in this scope."); return result;
  }
  async claimDue(input: { now?: Date; limit?: number; leaseMs?: number; scope?: PlanetScope }): Promise<IngestionJob[]> {
    const now = input.now ?? new Date(); const leaseUntil = new Date(now.getTime() + Math.max(1000, input.leaseMs ?? 60_000)); const jobs: IngestionJob[] = [];
    const limit = Math.max(1, Math.min(input.limit ?? 10, 100));
    await this.jobs.updateMany({ scopeId: scopeId(input.scope), $expr: { $gte: ["$attempts", "$maxAttempts"] }, $or: [{ status: "retry_wait", nextAttemptAt: { $lte: now } }, { status: "processing", leaseUntil: { $lte: now } }] }, { $set: { status: "failed", lastError: "Retry limit exceeded.", updatedAt: now }, $unset: { leaseUntil: "" } });
    for (let index = 0; index < limit; index += 1) {
      const job = await this.jobs.findOneAndUpdate({ scopeId: scopeId(input.scope), $expr: { $lt: ["$attempts", "$maxAttempts"] }, $or: [{ status: { $in: ["queued", "retry_wait"] }, nextAttemptAt: { $lte: now } }, { status: "processing", leaseUntil: { $lte: now } }] }, { $set: { status: "processing", leaseUntil, updatedAt: now }, $inc: { attempts: 1 } }, { sort: { nextAttemptAt: 1, _id: 1 }, returnDocument: "after", includeResultMetadata: false });
      if (!job) break;
      jobs.push(toIngestionJob(job));
    }
    return jobs;
  }
}

export function createMongoProvider(input: { id?: string; database: Db; vectorIndex?: string; vectorCollections?: Record<string, { dimensions: number; model?: string }> }): DataLayerProvider {
  return { id: input.id ?? "mongodb", graph: new MongoGraphStore(input.database), documents: new MongoDocumentStore(input.database), chunks: new MongoDocumentChunkStore(input.database), evidence: new MongoEvidenceStore(input.database), memories: new MongoMemoryStore(input.database), ingestionJobs: new MongoIngestionJobStore(input.database), vector: new MongoAtlasVectorStore(input.database, input.vectorIndex, input.vectorCollections) };
}

/** Create the compound indexes used by the Mongo adapters. Atlas vector search index definitions remain managed by Atlas. */
export async function initializeMongoIndexes(db: Db): Promise<void> {
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
  ]);
}
