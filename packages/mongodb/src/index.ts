import type { Db, Document, Filter } from "mongodb";
import type {
  AddEvidenceInput, CreateDocumentInput, CreateEdgeInput, CreateNodeInput, DataLayerProvider,
  DocumentId, DocumentStore, EdgeId, Evidence, EvidenceListInput, EvidenceStore, GraphEdge,
  GraphNode, GraphStore, GraphTraversal, JsonObject, NeighborsInput, NodeId, PlanetDocument,
  TraverseInput, UpdateNodeInput, VectorRecord, VectorSearchInput, VectorSearchResult, VectorStore,
} from "@unknown-planet/core";

interface NodeDoc extends Document { _id: string; type: string; name: string; properties: JsonObject; embedding?: number[]; createdAt: Date; updatedAt: Date }
interface EdgeDoc extends Document { _id: string; sourceId: string; targetId: string; relation: string; properties: JsonObject; confidence?: number; createdAt: Date; updatedAt: Date }
interface SourceDoc extends Document { _id: string; externalId?: string; title: string; contentUri: string; metadata: JsonObject; createdAt: Date; updatedAt: Date }
interface EvidenceDoc extends Document { _id: string; edgeId: string; documentId: string; chunkId?: string; sourceType?: string; extractor: string; confidence?: number; metadata: JsonObject; createdAt: Date }
interface VectorDoc extends Document { _id: string; namespace: string; embedding: number[]; metadata: JsonObject; createdAt: Date; updatedAt: Date }

const node = (value: NodeDoc): GraphNode => ({ id: value._id, type: value.type, name: value.name, properties: value.properties ?? {}, embedding: value.embedding, createdAt: value.createdAt, updatedAt: value.updatedAt });
const edge = (value: EdgeDoc): GraphEdge => ({ id: value._id, sourceId: value.sourceId, targetId: value.targetId, relation: value.relation, properties: value.properties ?? {}, confidence: value.confidence, createdAt: value.createdAt, updatedAt: value.updatedAt });
const source = (value: SourceDoc): PlanetDocument => ({ id: value._id, externalId: value.externalId, title: value.title, contentUri: value.contentUri, metadata: value.metadata ?? {}, createdAt: value.createdAt, updatedAt: value.updatedAt });
const evidence = (value: EvidenceDoc): Evidence => ({ id: value._id, edgeId: value.edgeId, documentId: value.documentId, chunkId: value.chunkId, sourceType: value.sourceType, extractor: value.extractor, confidence: value.confidence, metadata: value.metadata ?? {}, createdAt: value.createdAt });

/** MongoDB property-graph adapter. It validates edge endpoints and explicitly cascades node deletion. */
export class MongoGraphStore implements GraphStore {
  private readonly nodes;
  private readonly edges;
  private readonly evidence;
  constructor(db: Db) {
    this.nodes = db.collection<NodeDoc>("nodes");
    this.edges = db.collection<EdgeDoc>("edges");
    this.evidence = db.collection<EvidenceDoc>("evidence");
  }
  async createNode(input: CreateNodeInput): Promise<GraphNode> {
    const now = new Date(); const value: NodeDoc = { _id: input.id ?? crypto.randomUUID(), type: input.type, name: input.name, properties: input.properties ?? {}, embedding: input.embedding, createdAt: now, updatedAt: now };
    await this.nodes.insertOne(value); return node(value);
  }
  async getNode(id: NodeId): Promise<GraphNode | null> { const value = await this.nodes.findOne({ _id: id }); return value ? node(value) : null; }
  async updateNode(id: NodeId, input: UpdateNodeInput): Promise<GraphNode | null> {
    const $set: Partial<NodeDoc> = { updatedAt: new Date() };
    if (input.type !== undefined) $set.type = input.type;
    if (input.name !== undefined) $set.name = input.name;
    if (input.properties !== undefined) $set.properties = input.properties;
    if (input.embedding !== undefined && input.embedding !== null) $set.embedding = input.embedding;
    const update: Document = { $set };
    if (input.embedding === null) update.$unset = { embedding: "" };
    await this.nodes.updateOne({ _id: id }, update); return this.getNode(id);
  }
  async deleteNode(id: NodeId): Promise<boolean> {
    // Delete dependent evidence before edges, then the node: no operation leaves dangling edges.
    const edgeIds = (await this.edges.find({ $or: [{ sourceId: id }, { targetId: id }] }).project<{ _id: string }>({ _id: 1 }).toArray()).map((item) => item._id);
    if (edgeIds.length) { await this.evidence.deleteMany({ edgeId: { $in: edgeIds } }); await this.edges.deleteMany({ _id: { $in: edgeIds } }); }
    return (await this.nodes.deleteOne({ _id: id })).deletedCount === 1;
  }
  async createEdge(input: CreateEdgeInput): Promise<GraphEdge> {
    const [from, to] = await Promise.all([this.nodes.countDocuments({ _id: input.from }, { limit: 1 }), this.nodes.countDocuments({ _id: input.to }, { limit: 1 })]);
    if (!from || !to) throw new Error("Cannot create an edge whose endpoint node does not exist.");
    const now = new Date(); const value: EdgeDoc = { _id: input.id ?? crypto.randomUUID(), sourceId: input.from, targetId: input.to, relation: input.relation, properties: input.properties ?? {}, confidence: input.confidence, createdAt: now, updatedAt: now };
    await this.edges.insertOne(value); return edge(value);
  }
  async getEdge(id: EdgeId): Promise<GraphEdge | null> { const value = await this.edges.findOne({ _id: id }); return value ? edge(value) : null; }
  async deleteEdge(id: EdgeId): Promise<boolean> { await this.evidence.deleteMany({ edgeId: id }); return (await this.edges.deleteOne({ _id: id })).deletedCount === 1; }
  async neighbors(input: NeighborsInput): Promise<GraphEdge[]> {
    const direction = input.direction ?? "both";
    const endpoint: Filter<EdgeDoc> = direction === "outbound" ? { sourceId: input.nodeId } : direction === "inbound" ? { targetId: input.nodeId } : { $or: [{ sourceId: input.nodeId }, { targetId: input.nodeId }] };
    const filter = input.relation ? { $and: [endpoint, { relation: input.relation }] } : endpoint;
    return (await this.edges.find(filter).sort({ createdAt: 1, _id: 1 }).limit(input.limit ?? 100).toArray()).map(edge);
  }
  async traverse(input: TraverseInput): Promise<GraphTraversal> {
    const max = input.limit ?? 1000; const depths = new Map(input.startIds.map((id) => [id, 0])); const foundEdges = new Map<string, GraphEdge>(); let frontier = [...depths.keys()];
    for (let depth = 1; depth <= input.depth && frontier.length && depths.size < max; depth += 1) {
      const next: string[] = [];
      for (const id of frontier) for (const item of await this.neighbors({ nodeId: id, direction: input.direction, relation: input.relation, limit: max })) {
        foundEdges.set(item.id, item); const other = item.sourceId === id ? item.targetId : item.sourceId;
        if (!depths.has(other) && depths.size < max) { depths.set(other, depth); next.push(other); }
      }
      frontier = next;
    }
    const values = await this.nodes.find({ _id: { $in: [...depths.keys()] } }).toArray();
    return { nodes: values.map(node), edges: [...foundEdges.values()], depthByNode: Object.fromEntries(depths) };
  }
  async searchNodes(input: { query: string; limit?: number }): Promise<GraphNode[]> {
    const escaped = input.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return (await this.nodes.find({ name: { $regex: escaped, $options: "i" } }).sort({ name: 1, _id: 1 }).limit(input.limit ?? 20).toArray()).map(node);
  }
}

export class MongoDocumentStore implements DocumentStore {
  private readonly documents;
  constructor(db: Db) { this.documents = db.collection<SourceDoc>("documents"); }
  async create(input: CreateDocumentInput): Promise<PlanetDocument> { const now = new Date(); const value: SourceDoc = { _id: input.id ?? crypto.randomUUID(), externalId: input.externalId, title: input.title, contentUri: input.contentUri, metadata: input.metadata ?? {}, createdAt: now, updatedAt: now }; await this.documents.insertOne(value); return source(value); }
  async get(id: DocumentId): Promise<PlanetDocument | null> { const value = await this.documents.findOne({ _id: id }); return value ? source(value) : null; }
}

export class MongoEvidenceStore implements EvidenceStore {
  private readonly evidence;
  private readonly edges;
  private readonly documents;
  constructor(db: Db) { this.evidence = db.collection<EvidenceDoc>("evidence"); this.edges = db.collection<EdgeDoc>("edges"); this.documents = db.collection<SourceDoc>("documents"); }
  async add(input: AddEvidenceInput): Promise<Evidence> {
    const [edgeCount, documentCount] = await Promise.all([this.edges.countDocuments({ _id: input.edgeId }, { limit: 1 }), this.documents.countDocuments({ _id: input.documentId }, { limit: 1 })]);
    if (!edgeCount || !documentCount) throw new Error("Evidence requires an existing edge and document.");
    const value: EvidenceDoc = { _id: input.id ?? crypto.randomUUID(), edgeId: input.edgeId, documentId: input.documentId, chunkId: input.chunkId, sourceType: input.sourceType, extractor: input.extractor, confidence: input.confidence, metadata: input.metadata ?? {}, createdAt: new Date() };
    await this.evidence.insertOne(value); return evidence(value);
  }
  async list(input: EvidenceListInput): Promise<Evidence[]> {
    const filter: Filter<EvidenceDoc> = {};
    if (input.edgeId) filter.edgeId = input.edgeId;
    if (input.edgeIds?.length) filter.edgeId = { $in: input.edgeIds };
    if (input.documentId) filter.documentId = input.documentId;
    return (await this.evidence.find(filter).sort({ createdAt: 1, _id: 1 }).limit(input.limit ?? 100).toArray()).map(evidence);
  }
}

/** Uses MongoDB Atlas Vector Search. Create an Atlas vector index for `embedding` before querying. */
export class MongoAtlasVectorStore implements VectorStore {
  private readonly vectors;
  constructor(db: Db, private readonly vectorIndex = "unknownplanet_vectors") { this.vectors = db.collection<VectorDoc>("vectors"); }
  async upsert(input: VectorRecord): Promise<void> { await this.vectors.updateOne({ _id: input.id }, { $set: { namespace: input.namespace, embedding: input.embedding, metadata: input.metadata ?? {}, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } }, { upsert: true }); }
  async search(input: VectorSearchInput): Promise<VectorSearchResult[]> {
    const limit = input.limit ?? 20; const vectorSearch: Document = { index: this.vectorIndex, path: "embedding", queryVector: input.embedding, numCandidates: Math.max(limit * 10, 100), limit };
    if (input.namespace) vectorSearch.filter = { namespace: input.namespace };
    const rows = await this.vectors.aggregate<{ _id: string; namespace: string; metadata: JsonObject; score: number }>([{ $vectorSearch: vectorSearch }, { $project: { _id: 1, namespace: 1, metadata: 1, score: { $meta: "vectorSearchScore" } } }]).toArray();
    return rows.map((row) => ({ id: row._id, namespace: row.namespace, metadata: row.metadata ?? {}, score: row.score }));
  }
  async delete(id: string): Promise<void> { await this.vectors.deleteOne({ _id: id }); }
}

export function createMongoProvider(input: { id?: string; database: Db; vectorIndex?: string }): DataLayerProvider {
  return { id: input.id ?? "mongodb", graph: new MongoGraphStore(input.database), documents: new MongoDocumentStore(input.database), evidence: new MongoEvidenceStore(input.database), vector: new MongoAtlasVectorStore(input.database, input.vectorIndex) };
}
