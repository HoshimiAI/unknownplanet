import { randomUUID } from "node:crypto";
import { metrics, SpanStatusCode, trace } from "@opentelemetry/api";
import { EmbeddingDimensionMismatchError, type AddEvidenceInput, type AddMemoryInput, type CreateDocumentChunkInput, type CreateDocumentInput, type CreateEdgeInput, type CreateIngestionJobInput, type CreateNodeInput, type DataLayerProvider, type DocumentChunk, type DocumentChunkStore, type DocumentId, type DocumentStore, type EdgeId, type Evidence, type EvidenceListInput, type EvidenceStore, type GraphEdge, type GraphNode, type GraphStore, type GraphTraversal, type IdentityBinding, type IdentityStore, type IngestionJob, type IngestionJobStore, type JsonObject, type MemoryRecord, type MemorySearchInput, type MemoryStore, type NeighborsInput, type NodeId, type NodeMergeRecord, type PlanetDocument, type PlanetIdentity, type PlanetScope, type SqlQueryInput, type SqlQueryResult, type SqlStore, type SqlTransaction, type TraverseInput, type UpdateEdgeInput, type UpdateIngestionJobInput, type UpdateNodeInput, type VectorCollectionConfig as CoreVectorCollectionConfig, type VectorRecord, type VectorSearchInput, type VectorSearchResult, type VectorStore } from "@unknown-planet/core";

export interface PostgresDatabase { query<T extends Record<string, unknown> = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<{ rows: T[]; rowCount: number | null }> }
export interface PostgresConnection extends PostgresDatabase { release(): void }
export interface PostgresTransactionalDatabase extends PostgresDatabase { connect(): Promise<PostgresConnection> }
const supportsTransactions = (database: PostgresDatabase): database is PostgresTransactionalDatabase => "connect" in database && typeof database.connect === "function";
const scopeId = (scope?: PlanetScope) => scope?.workspaceId ? `${scope.tenantId}:${scope.workspaceId}` : (scope?.tenantId ?? "default");
const dbTracer = trace.getTracer("@unknown-planet/postgres", "0.1.0");
const dbMeter = metrics.getMeter("@unknown-planet/postgres", "0.1.0");
const dbQueries = dbMeter.createCounter("db.client.operation.count", { description: "PostgreSQL queries issued by Unknown Planet" });
const dbQueryDuration = dbMeter.createHistogram("db.client.operation.duration", { unit: "ms", description: "PostgreSQL query duration" });
function sqlOperation(text: string): string { return text.match(/^\s*([a-z]+)/i)?.[1]?.toLowerCase() ?? "other"; }
async function measuredQuery<T extends Record<string, unknown>>(text: string, values: readonly unknown[] | undefined, query: () => Promise<{ rows: T[]; rowCount: number | null }>) {
  const operation = sqlOperation(text); const started = performance.now(); const attributes = { "db.system.name": "postgresql", "db.operation.name": operation };
  return dbTracer.startActiveSpan(`postgresql.${operation}`, { attributes }, async (span) => {
    try { const result = await query(); dbQueries.add(1, { ...attributes, outcome: "success" }); return result; }
    catch (error) { span.recordException(error instanceof Error ? error : new Error("Unknown database failure")); span.setStatus({ code: SpanStatusCode.ERROR }); dbQueries.add(1, { ...attributes, outcome: "error" }); throw error; }
    finally { dbQueryDuration.record(performance.now() - started, attributes); span.end(); }
  });
}
function instrumentPostgresDatabase(database: PostgresDatabase): PostgresDatabase {
  const instrumented: PostgresDatabase & Partial<PostgresTransactionalDatabase> = {
    query: <T extends Record<string, unknown> = Record<string, unknown>>(text: string, values?: readonly unknown[]) => measuredQuery(text, values, () => database.query<T>(text, values)),
  };
  if (supportsTransactions(database)) instrumented.connect = async () => {
    const connection = await database.connect();
    return { query: <T extends Record<string, unknown> = Record<string, unknown>>(text: string, values?: readonly unknown[]) => measuredQuery(text, values, () => connection.query<T>(text, values)), release: () => connection.release() };
  };
  return instrumented;
}
type NodeRow = { id: string; type: string; name: string; properties: JsonObject; embedding: string | null; created_at: Date; updated_at: Date };
type EdgeRow = { id: string; source_id: string; target_id: string; relation: string; properties: JsonObject; confidence: number | null; valid_from: Date | null; valid_to: Date | null; status: GraphEdge["status"]; created_at: Date; updated_at: Date };
type NodeMergeRow = { source_id: string; target_id: string; merged_at: Date; source_node: GraphNode; target_before: GraphNode; target_after: GraphNode };
type IngestionJobRow = { id: string; kind: IngestionJob["kind"]; status: IngestionJob["status"]; checkpoint: IngestionJob["checkpoint"]; attempts: number; max_attempts: number; input: JsonObject; next_attempt_at: Date; lease_until: Date | null; last_error: string | null; created_at: Date; updated_at: Date };
type DocumentRow = { id: string; external_id: string | null; title: string; content_uri: string; metadata: JsonObject; created_at: Date; updated_at: Date };
type ChunkRow = { id: string; document_id: string; content_uri: string | null; text_content: string | null; start_offset: number | null; end_offset: number | null; metadata: JsonObject; created_at: Date; updated_at: Date };
type EvidenceRow = { id: string; edge_id: string; document_id: string | null; source_id: string | null; chunk_id: string | null; source_type: string | null; extractor: string; confidence: number | null; direction: Evidence["direction"]; strength: number | null; metadata: JsonObject; created_at: Date };
const nodes = "id,type,name,properties,embedding::text AS embedding,created_at,updated_at"; const edges = "id,source_id,target_id,relation,properties,confidence,valid_from,valid_to,status,created_at,updated_at"; const documents = "id,external_id,title,content_uri,metadata,created_at,updated_at"; const chunks = "id,document_id,content_uri,text_content,start_offset,end_offset,metadata,created_at,updated_at"; const evidence = "id,edge_id,document_id,source_id,chunk_id,source_type,extractor,confidence,direction,strength,metadata,created_at";
const vectorLiteral = (value: number[]) => { if (!value.length || value.some((n) => !Number.isFinite(n))) throw new Error("An embedding must contain finite numbers."); return `[${value.join(",")}]`; };
const parseVector = (value: string | null): number[] | undefined => value === null ? undefined : JSON.parse(value.replaceAll("{", "[").replaceAll("}", "]")) as number[];
const node = (row: NodeRow): GraphNode => ({ id: row.id, type: row.type, name: row.name, properties: row.properties ?? {}, embedding: parseVector(row.embedding), createdAt: row.created_at, updatedAt: row.updated_at });
const rowToMerge = (row: NodeMergeRow): NodeMergeRecord => ({ sourceId: row.source_id, targetId: row.target_id, mergedAt: row.merged_at, source: { ...row.source_node, createdAt: new Date(row.source_node.createdAt), updatedAt: new Date(row.source_node.updatedAt) }, targetBefore: { ...row.target_before, createdAt: new Date(row.target_before.createdAt), updatedAt: new Date(row.target_before.updatedAt) }, targetAfter: { ...row.target_after, createdAt: new Date(row.target_after.createdAt), updatedAt: new Date(row.target_after.updatedAt) } });
const rowToIngestionJob = (row: IngestionJobRow): IngestionJob => ({ id: row.id, kind: row.kind, status: row.status, checkpoint: row.checkpoint, attempts: row.attempts, maxAttempts: row.max_attempts, input: row.input ?? {}, nextAttemptAt: row.next_attempt_at, leaseUntil: row.lease_until ?? undefined, lastError: row.last_error ?? undefined, createdAt: row.created_at, updatedAt: row.updated_at });
const edge = (row: EdgeRow): GraphEdge => ({ id: row.id, sourceId: row.source_id, targetId: row.target_id, relation: row.relation, properties: row.properties ?? {}, confidence: row.confidence ?? undefined, validFrom: row.valid_from ?? undefined, validTo: row.valid_to ?? undefined, status: row.status ?? "candidate", createdAt: row.created_at, updatedAt: row.updated_at });
const document = (row: DocumentRow): PlanetDocument => ({ id: row.id, externalId: row.external_id ?? undefined, title: row.title, contentUri: row.content_uri, metadata: row.metadata ?? {}, createdAt: row.created_at, updatedAt: row.updated_at });
const chunk = (row: ChunkRow): DocumentChunk => ({ id: row.id, documentId: row.document_id, contentUri: row.content_uri ?? undefined, text: row.text_content ?? undefined, startOffset: row.start_offset ?? undefined, endOffset: row.end_offset ?? undefined, metadata: row.metadata ?? {}, createdAt: row.created_at, updatedAt: row.updated_at });
const toEvidence = (row: EvidenceRow): Evidence => ({ id: row.id, edgeId: row.edge_id, documentId: row.document_id ?? undefined, sourceId: row.source_id ?? undefined, chunkId: row.chunk_id ?? undefined, sourceType: row.source_type ?? undefined, extractor: row.extractor, confidence: row.confidence ?? undefined, direction: row.direction ?? "support", strength: row.strength ?? undefined, metadata: row.metadata ?? {}, createdAt: row.created_at });
const identifier = (value: string) => { if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error("PostgreSQL schema names must be simple identifiers."); return `"${value}"`; };
const planetTables = "nodes|edges|entity_merges|documents|document_chunks|evidence|vectors|memories|ingestion_jobs|identities|identity_aliases|identity_bindings";
function schemaDatabase(database: PostgresDatabase, schema = "public"): PostgresDatabase {
  if (schema === "public") return database;
  const quoted = identifier(schema);
  const relation = new RegExp(`\\b(DELETE\\s+FROM|FROM|JOIN|INTO|UPDATE|REFERENCES)\\s+(${planetTables})\\b`, "gi");
  const route = (text: string) => text.replace(relation, (_match, keyword: string, table: string) => `${keyword} ${quoted}.${table}`);
  const scoped: PostgresDatabase & Partial<PostgresTransactionalDatabase> = {
    query: <T extends Record<string, unknown> = Record<string, unknown>>(text: string, values?: readonly unknown[]) => database.query<T>(route(text), values),
  };
  if (supportsTransactions(database)) scoped.connect = async () => {
    const connection = await database.connect();
    return { query: <T extends Record<string, unknown> = Record<string, unknown>>(text: string, values?: readonly unknown[]) => connection.query<T>(route(text), values), release: () => connection.release() };
  };
  return scoped;
}

export class PostgresGraphStore implements GraphStore {
  constructor(private readonly db: PostgresDatabase) {}
  async createNode(input: CreateNodeInput): Promise<GraphNode> { const result = await this.db.query<NodeRow>(`INSERT INTO nodes (id,scope_id,type,name,properties,embedding) VALUES ($1,$2,$3,$4,$5::jsonb,$6::vector) RETURNING ${nodes}`, [input.id ?? randomUUID(), scopeId(input.scope), input.type, input.name, JSON.stringify(input.properties ?? {}), input.embedding ? vectorLiteral(input.embedding) : null]); return node(result.rows[0]!); }
  async getNode(id: NodeId, scope?: PlanetScope): Promise<GraphNode | null> { const result = await this.db.query<NodeRow>(`SELECT ${nodes} FROM nodes WHERE id=$1 AND scope_id=$2`, [id, scopeId(scope)]); return result.rows[0] ? node(result.rows[0]) : null; }
  async updateNode(id: NodeId, input: UpdateNodeInput): Promise<GraphNode | null> { const fields: string[] = []; const values: unknown[] = []; const add = (field: string, value: unknown) => { values.push(value); fields.push(`${field}=$${values.length}`); }; if (input.type !== undefined) add("type", input.type); if (input.name !== undefined) add("name", input.name); if (input.properties !== undefined) add("properties", JSON.stringify(input.properties)); if (input.embedding !== undefined) add("embedding", input.embedding === null ? null : vectorLiteral(input.embedding)); if (!fields.length) return this.getNode(id, input.scope); values.push(id, scopeId(input.scope)); const result = await this.db.query<NodeRow>(`UPDATE nodes SET ${fields.join(",")},updated_at=now() WHERE id=$${values.length - 1} AND scope_id=$${values.length} RETURNING ${nodes}`, values); return result.rows[0] ? node(result.rows[0]) : null; }
  async deleteNode(id: NodeId, scope?: PlanetScope): Promise<boolean> { const result = await this.db.query("DELETE FROM nodes WHERE id=$1 AND scope_id=$2", [id, scopeId(scope)]); return (result.rowCount ?? 0) > 0; }
  async mergeNodes(input: { sourceId: NodeId; targetId: NodeId; scope?: PlanetScope }): Promise<NodeMergeRecord> {
    if (input.sourceId === input.targetId) throw new Error("A node cannot be merged into itself.");
    if (!supportsTransactions(this.db)) throw new Error("Node merges require a transactional PostgreSQL pool.");
    const connection = await this.db.connect(); const currentScope = scopeId(input.scope);
    try {
      await connection.query("BEGIN");
      const locked = await connection.query<NodeRow>(`SELECT ${nodes} FROM nodes WHERE scope_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE`, [currentScope, [input.sourceId, input.targetId]]);
      if (locked.rows.length !== 2) throw new Error("Both merge nodes must exist in this scope.");
      const nodeById = new Map(locked.rows.map((row) => [row.id, node(row)]));
      const sourceSnapshot = nodeById.get(input.sourceId)!; const targetBefore = nodeById.get(input.targetId)!;
      const sourceAliases = Array.isArray(sourceSnapshot.properties.aliases) ? sourceSnapshot.properties.aliases.filter((value): value is string => typeof value === "string") : [];
      const targetAliases = Array.isArray(targetBefore.properties.aliases) ? targetBefore.properties.aliases.filter((value): value is string => typeof value === "string") : [];
      const targetAfter: GraphNode = { ...targetBefore, properties: { ...targetBefore.properties, aliases: [...new Set([...targetAliases, sourceSnapshot.name, ...sourceAliases])] }, updatedAt: new Date() };
      await connection.query("UPDATE nodes SET properties=$1::jsonb,updated_at=$2 WHERE scope_id=$3 AND id=$4", [JSON.stringify(targetAfter.properties), targetAfter.updatedAt, currentScope, input.targetId]);
      const incident = await connection.query<{ id: string; source_id: string; target_id: string }>("SELECT id,source_id,target_id FROM edges WHERE scope_id=$1 AND (source_id=$2 OR target_id=$2) ORDER BY id FOR UPDATE", [currentScope, input.sourceId]);
      for (const candidate of incident.rows) {
        const from = candidate.source_id === input.sourceId ? input.targetId : candidate.source_id;
        const to = candidate.target_id === input.sourceId ? input.targetId : candidate.target_id;
        // Keep parallel edges distinct: they can carry different time ranges, properties, and evidence.
        await connection.query("UPDATE edges SET source_id=$1,target_id=$2,updated_at=now() WHERE scope_id=$3 AND id=$4", [from, to, currentScope, candidate.id]);
      }
      await connection.query("DELETE FROM nodes WHERE scope_id=$1 AND id=$2", [currentScope, input.sourceId]);
      const result = await connection.query<NodeMergeRow>("INSERT INTO entity_merges(scope_id,source_id,target_id,source_node,target_before,target_after) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb) ON CONFLICT(scope_id,source_id) DO UPDATE SET target_id=EXCLUDED.target_id,source_node=EXCLUDED.source_node,target_before=EXCLUDED.target_before,target_after=EXCLUDED.target_after,merged_at=now() RETURNING source_id,target_id,merged_at,source_node,target_before,target_after", [currentScope, input.sourceId, input.targetId, JSON.stringify(sourceSnapshot), JSON.stringify(targetBefore), JSON.stringify(targetAfter)]);
      await connection.query("COMMIT");
      return rowToMerge(result.rows[0]!);
    } catch (error) { await connection.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { connection.release(); }
  }
  async listMerges(input: { nodeId?: NodeId; limit?: number; scope?: PlanetScope }): Promise<NodeMergeRecord[]> {
    const values: unknown[] = [scopeId(input.scope)]; const filter = input.nodeId ? " AND (source_id=$2 OR target_id=$2)" : "";
    if (input.nodeId) values.push(input.nodeId); values.push(Math.max(1, Math.min(input.limit ?? 100, 100000)));
    const result = await this.db.query<NodeMergeRow>(`SELECT source_id,target_id,merged_at,source_node,target_before,target_after FROM entity_merges WHERE scope_id=$1${filter} ORDER BY merged_at DESC,source_id LIMIT $${values.length}`, values);
    return result.rows.map(rowToMerge);
  }
  async createEdge(input: CreateEdgeInput): Promise<GraphEdge> { if (input.validFrom && input.validTo && input.validTo <= input.validFrom) throw new Error("validTo must be later than validFrom."); const result = await this.db.query<EdgeRow>(`INSERT INTO edges (id,scope_id,source_id,target_id,relation,properties,confidence,valid_from,valid_to,status) SELECT $1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10 WHERE EXISTS (SELECT 1 FROM nodes WHERE id=$3 AND scope_id=$2) AND EXISTS (SELECT 1 FROM nodes WHERE id=$4 AND scope_id=$2) RETURNING ${edges}`, [input.id ?? randomUUID(), scopeId(input.scope), input.from, input.to, input.relation, JSON.stringify(input.properties ?? {}), input.confidence ?? null, input.validFrom ?? null, input.validTo ?? null, input.status ?? "candidate"]); if (!result.rows[0]) throw new Error("Cannot create an edge whose endpoint node does not exist in this scope."); return edge(result.rows[0]); }
  async getEdge(id: EdgeId, scope?: PlanetScope): Promise<GraphEdge | null> { const result = await this.db.query<EdgeRow>(`SELECT ${edges} FROM edges WHERE id=$1 AND scope_id=$2`, [id, scopeId(scope)]); return result.rows[0] ? edge(result.rows[0]) : null; }
  async updateEdge(id: EdgeId, input: UpdateEdgeInput): Promise<GraphEdge | null> { const setters: string[] = []; const values: unknown[] = []; const add = (field: string, value: unknown) => { values.push(value); setters.push(`${field}=$${values.length}`); }; if (input.confidence !== undefined) add("confidence", input.confidence); if (input.status !== undefined) add("status", input.status); if (input.validFrom !== undefined) add("valid_from", input.validFrom); if (input.validTo !== undefined) add("valid_to", input.validTo); if (input.properties !== undefined) add("properties", JSON.stringify(input.properties)); if (!setters.length) return this.getEdge(id, input.scope); values.push(id, scopeId(input.scope)); const result = await this.db.query<EdgeRow>(`UPDATE edges SET ${setters.join(",")},updated_at=now() WHERE id=$${values.length - 1} AND scope_id=$${values.length} RETURNING ${edges}`, values); return result.rows[0] ? edge(result.rows[0]) : null; }
  async deleteEdge(id: EdgeId, scope?: PlanetScope): Promise<boolean> { const result = await this.db.query("DELETE FROM edges WHERE id=$1 AND scope_id=$2", [id, scopeId(scope)]); return (result.rowCount ?? 0) > 0; }
  async neighbors(input: NeighborsInput): Promise<GraphEdge[]> { return this.neighborsFor([input.nodeId], input.scope, input.direction, input.relation, input.limit ?? 100, input.asOf); }
  private async neighborsFor(ids: string[], scope: PlanetScope | undefined, direction = "both", relation?: string, limit = 1000, asOf?: Date): Promise<GraphEdge[]> { const predicate = direction === "outbound" ? "source_id=ANY($1::uuid[])" : direction === "inbound" ? "target_id=ANY($1::uuid[])" : "(source_id=ANY($1::uuid[]) OR target_id=ANY($1::uuid[]))"; const values: unknown[] = [ids, scopeId(scope)]; const clauses = [predicate, "scope_id=$2"]; if (relation) { values.push(relation); clauses.push(`relation=$${values.length}`); } values.push(asOf ?? null); const asOfParam = values.length; clauses.push(`($${asOfParam}::timestamptz IS NULL OR (valid_from IS NULL OR valid_from <= $${asOfParam}) AND (valid_to IS NULL OR valid_to > $${asOfParam}))`); values.push(limit); const result = await this.db.query<EdgeRow>(`SELECT ${edges} FROM edges WHERE ${clauses.join(" AND ")} ORDER BY created_at,id LIMIT $${values.length}`, values); return result.rows.map(edge); }
  async traverse(input: TraverseInput): Promise<GraphTraversal> { const limit = input.limit ?? 1000; const visited = new Map<string, number>(input.startIds.map((id) => [id, 0])); const found = new Map<string, GraphEdge>(); let frontier = [...visited.keys()]; for (let depth = 1; depth <= input.depth && frontier.length && visited.size < limit; depth += 1) { const next: string[] = []; for (const item of await this.neighborsFor(frontier, input.scope, input.direction, input.relation, limit, input.asOf)) { found.set(item.id, item); for (const id of [item.sourceId, item.targetId]) if (!visited.has(id) && visited.size < limit) { visited.set(id, depth); next.push(id); } } frontier = next; } const result = await this.db.query<NodeRow>(`SELECT ${nodes} FROM nodes WHERE id=ANY($1::uuid[]) AND scope_id=$2`, [[...visited.keys()], scopeId(input.scope)]); return { nodes: result.rows.map(node), edges: [...found.values()], depthByNode: Object.fromEntries(visited) }; }
  async searchNodes(input: { query: string; limit?: number; scope?: PlanetScope }): Promise<GraphNode[]> { const result = await this.db.query<NodeRow>(`SELECT ${nodes} FROM nodes WHERE scope_id=$1 AND (name ILIKE '%' || $2 || '%' OR properties::text ILIKE '%' || $2 || '%') ORDER BY CASE WHEN lower(name)=lower($2) THEN 0 ELSE 1 END,name,id LIMIT $3`, [scopeId(input.scope), input.query, input.limit ?? 20]); return result.rows.map(node); }
}
export class PostgresDocumentStore implements DocumentStore { constructor(private readonly db: PostgresDatabase) {} async create(input: CreateDocumentInput): Promise<PlanetDocument> { const result = await this.db.query<DocumentRow>(`INSERT INTO documents (id,scope_id,external_id,title,content_uri,metadata) VALUES ($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title,content_uri=EXCLUDED.content_uri,metadata=EXCLUDED.metadata,updated_at=now() WHERE documents.scope_id=EXCLUDED.scope_id RETURNING ${documents}`, [input.id ?? randomUUID(), scopeId(input.scope), input.externalId ?? null, input.title, input.contentUri, JSON.stringify(input.metadata ?? {})]); if (!result.rows[0]) throw new Error("Document id already exists outside this scope."); return document(result.rows[0]); } async get(id: DocumentId, scope?: PlanetScope): Promise<PlanetDocument | null> { const result = await this.db.query<DocumentRow>(`SELECT ${documents} FROM documents WHERE id=$1 AND scope_id=$2`, [id, scopeId(scope)]); return result.rows[0] ? document(result.rows[0]) : null; } async delete(id: DocumentId, scope?: PlanetScope): Promise<boolean> { const result = await this.db.query("DELETE FROM documents WHERE id=$1 AND scope_id=$2", [id, scopeId(scope)]); return (result.rowCount ?? 0) > 0; } }
export class PostgresDocumentChunkStore implements DocumentChunkStore { constructor(private readonly db: PostgresDatabase) {} async create(input: CreateDocumentChunkInput): Promise<DocumentChunk> { if (!input.text && !input.contentUri) throw new Error("A document chunk requires text or a content URI."); const result = await this.db.query<ChunkRow>(`INSERT INTO document_chunks (id,scope_id,document_id,content_uri,text_content,start_offset,end_offset,metadata) SELECT $1,$2,$3,$4,$5,$6,$7,$8::jsonb WHERE EXISTS (SELECT 1 FROM documents WHERE id=$3 AND scope_id=$2) ON CONFLICT (id) DO UPDATE SET content_uri=EXCLUDED.content_uri,text_content=EXCLUDED.text_content,start_offset=EXCLUDED.start_offset,end_offset=EXCLUDED.end_offset,metadata=EXCLUDED.metadata,updated_at=now() WHERE document_chunks.scope_id=EXCLUDED.scope_id AND document_chunks.document_id=EXCLUDED.document_id RETURNING ${chunks}`, [input.id ?? randomUUID(), scopeId(input.scope), input.documentId, input.contentUri ?? null, input.text ?? null, input.startOffset ?? null, input.endOffset ?? null, JSON.stringify(input.metadata ?? {})]); if (!result.rows[0]) throw new Error("A chunk requires an existing document in this scope and cannot be moved between documents."); return chunk(result.rows[0]); } async get(id: string, scope?: PlanetScope): Promise<DocumentChunk | null> { const result = await this.db.query<ChunkRow>(`SELECT ${chunks} FROM document_chunks WHERE id=$1 AND scope_id=$2`, [id, scopeId(scope)]); return result.rows[0] ? chunk(result.rows[0]) : null; } async list(input: { documentId: string; limit?: number; scope?: PlanetScope }): Promise<DocumentChunk[]> { const result = await this.db.query<ChunkRow>(`SELECT ${chunks} FROM document_chunks WHERE document_id=$1 AND scope_id=$2 ORDER BY start_offset NULLS LAST,id LIMIT $3`, [input.documentId, scopeId(input.scope), input.limit ?? 100]); return result.rows.map(chunk); } async listPage(input: { documentId: string; limit?: number; afterId?: string; scope?: PlanetScope }): Promise<{ items: DocumentChunk[]; hasMore: boolean }> { const limit = Math.max(1, Math.min(input.limit ?? 100, 500)); const result = await this.db.query<ChunkRow>("SELECT * FROM document_chunks WHERE document_id=$1 AND scope_id=$2 AND ($3::uuid IS NULL OR id>$3::uuid) ORDER BY id LIMIT $4", [input.documentId, scopeId(input.scope), input.afterId ?? null, limit + 1]); return { items: result.rows.slice(0, limit).map(chunk), hasMore: result.rows.length > limit }; } async search(input: { query: string; limit?: number; scope?: PlanetScope }): Promise<DocumentChunk[]> { const result = await this.db.query<ChunkRow>(`SELECT ${chunks} FROM document_chunks WHERE scope_id=$1 AND to_tsvector('simple',coalesce(text_content,'')) @@ plainto_tsquery('simple',$2) ORDER BY ts_rank(to_tsvector('simple',coalesce(text_content,'')),plainto_tsquery('simple',$2)) DESC,id LIMIT $3`, [scopeId(input.scope), input.query, input.limit ?? 20]); return result.rows.map(chunk); } async deleteExcept(input: { documentId: string; keepIds: string[]; scope?: PlanetScope }): Promise<number> { const result = await this.db.query("DELETE FROM document_chunks WHERE scope_id=$1 AND document_id=$2 AND NOT (id=ANY($3::uuid[]))", [scopeId(input.scope), input.documentId, input.keepIds]); return result.rowCount ?? 0; } }
export class PostgresEvidenceStore implements EvidenceStore {
  constructor(private readonly db: PostgresDatabase) {}
  async add(input: AddEvidenceInput): Promise<Evidence> {
    if (!input.documentId && !input.sourceId) throw new Error("Evidence requires a documentId or sourceId.");
    const result = await this.db.query<EvidenceRow>(`INSERT INTO evidence (id,scope_id,edge_id,document_id,source_id,chunk_id,source_type,extractor,confidence,direction,strength,metadata) SELECT $1,$2,$3,$4,$5,$6::text,$7,$8,$9,$10,$11,$12::jsonb WHERE EXISTS (SELECT 1 FROM edges WHERE id=$3 AND scope_id=$2) AND ($4::uuid IS NULL OR EXISTS (SELECT 1 FROM documents WHERE id=$4 AND scope_id=$2)) AND ($6::text::uuid IS NULL OR EXISTS (SELECT 1 FROM document_chunks WHERE id=$6::text::uuid AND document_id=$4 AND scope_id=$2)) RETURNING ${evidence}`, [input.id ?? randomUUID(), scopeId(input.scope), input.edgeId, input.documentId ?? null, input.sourceId ?? null, input.chunkId ?? null, input.sourceType ?? null, input.extractor, input.confidence ?? null, input.direction ?? "support", input.strength ?? input.confidence ?? null, JSON.stringify(input.metadata ?? {})]);
    if (!result.rows[0]) throw new Error("Evidence requires a scoped edge and a valid document/chunk source.");
    return toEvidence(result.rows[0]);
  }
  async list(input: EvidenceListInput): Promise<Evidence[]> {
    const values: unknown[] = [scopeId(input.scope)]; const clauses = ["scope_id=$1"];
    if (input.edgeId) { values.push(input.edgeId); clauses.push(`edge_id=$${values.length}`); }
    if (input.edgeIds?.length) { values.push(input.edgeIds); clauses.push(`edge_id=ANY($${values.length}::uuid[])`); }
    if (input.documentId) { values.push(input.documentId); clauses.push(`document_id=$${values.length}`); }
    if (input.sourceId) { values.push(input.sourceId); clauses.push(`source_id=$${values.length}`); }
    values.push(input.limit ?? 100); const result = await this.db.query<EvidenceRow>(`SELECT ${evidence} FROM evidence WHERE ${clauses.join(" AND ")} ORDER BY created_at,id LIMIT $${values.length}`, values);
    return result.rows.map(toEvidence);
  }
  async deleteByDocument(input: { documentId: string; scope?: PlanetScope }): Promise<number> { const result = await this.db.query("DELETE FROM evidence WHERE scope_id=$1 AND document_id=$2", [scopeId(input.scope), input.documentId]); return result.rowCount ?? 0; }
}

type MemoryRow = { id: string; agent_id: string; user_id: string | null; session_id: string | null; content: string; memory_type: MemoryRecord["type"]; importance: number | null; confidence: number | null; source: MemoryRecord["source"] | null; metadata: JsonObject; created_at: Date; updated_at: Date };
const memoryFields = "id,agent_id,user_id,session_id,content,memory_type,importance,confidence,source,metadata,created_at,updated_at";
const toMemory = (row: MemoryRow): MemoryRecord => ({ id: row.id, agentId: row.agent_id, userId: row.user_id ?? undefined, sessionId: row.session_id ?? undefined, content: row.content, type: row.memory_type, importance: row.importance ?? undefined, confidence: row.confidence ?? undefined, source: row.source ?? undefined, metadata: row.metadata ?? {}, createdAt: row.created_at, updatedAt: row.updated_at });
export class PostgresMemoryStore implements MemoryStore {
  constructor(private readonly db: PostgresDatabase) {}
  async add(input: AddMemoryInput): Promise<MemoryRecord> {
    const result = await this.db.query<MemoryRow>(`INSERT INTO memories (scope_id,id,agent_id,user_id,session_id,content,memory_type,importance,confidence,source,metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb) ON CONFLICT (scope_id,id) DO UPDATE SET agent_id=EXCLUDED.agent_id,user_id=EXCLUDED.user_id,session_id=EXCLUDED.session_id,content=EXCLUDED.content,memory_type=EXCLUDED.memory_type,importance=EXCLUDED.importance,confidence=EXCLUDED.confidence,source=EXCLUDED.source,metadata=EXCLUDED.metadata,updated_at=now() RETURNING ${memoryFields}`, [scopeId(input.scope), input.id ?? randomUUID(), input.agentId, input.userId ?? null, input.sessionId ?? null, input.content, input.type ?? "fact", input.importance ?? null, input.confidence ?? null, input.source ? JSON.stringify(input.source) : null, JSON.stringify(input.metadata ?? {})]);
    return toMemory(result.rows[0]!);
  }
  async get(id: string, scope?: PlanetScope): Promise<MemoryRecord | null> { const result = await this.db.query<MemoryRow>(`SELECT ${memoryFields} FROM memories WHERE scope_id=$1 AND id=$2`, [scopeId(scope), id]); return result.rows[0] ? toMemory(result.rows[0]) : null; }
  async search(input: MemorySearchInput): Promise<MemoryRecord[]> {
    const values: unknown[] = [scopeId(input.scope)]; const where = ["scope_id=$1"];
    for (const [field, value] of [["agent_id", input.agentId], ["user_id", input.userId], ["session_id", input.sessionId], ["memory_type", input.type]] as const) if (value) { values.push(value); where.push(`${field}=$${values.length}`); }
    if (input.metadata) { values.push(JSON.stringify(input.metadata)); where.push(`metadata @> $${values.length}::jsonb`); }
    let rank = "0";
    if (input.query?.trim()) { values.push(input.query.trim()); rank = `ts_rank(to_tsvector('simple',content),plainto_tsquery('simple',$${values.length}))`; where.push(`to_tsvector('simple',content) @@ plainto_tsquery('simple',$${values.length})`); }
    values.push(input.limit ?? 20);
    const result = await this.db.query<MemoryRow>(`SELECT ${memoryFields} FROM memories WHERE ${where.join(" AND ")} ORDER BY ${rank} DESC,created_at DESC,id LIMIT $${values.length}`, values);
    return result.rows.map(toMemory);
  }
  async searchPage(input: MemorySearchInput & { afterId?: string }): Promise<{ items: MemoryRecord[]; hasMore: boolean }> {
    const values: unknown[] = [scopeId(input.scope)]; const where = ["scope_id=$1"];
    for (const [field, value] of [["agent_id", input.agentId], ["user_id", input.userId], ["session_id", input.sessionId], ["memory_type", input.type]] as const) if (value) { values.push(value); where.push(`${field}=$${values.length}`); }
    if (input.metadata) { values.push(JSON.stringify(input.metadata)); where.push(`metadata @> $${values.length}::jsonb`); }
    if (input.query?.trim()) { values.push(input.query.trim()); where.push(`to_tsvector('simple',content) @@ plainto_tsquery('simple',$${values.length})`); }
    if (input.afterId) { values.push(input.afterId); where.push(`id>$${values.length}`); }
    const limit = Math.max(1, Math.min(input.limit ?? 20, 500)); values.push(limit + 1);
    const result = await this.db.query<MemoryRow>(`SELECT ${memoryFields} FROM memories WHERE ${where.join(" AND ")} ORDER BY id LIMIT $${values.length}`, values);
    return { items: result.rows.slice(0, limit).map(toMemory), hasMore: result.rows.length > limit };
  }
  async delete(id: string, scope?: PlanetScope): Promise<boolean> { const result = await this.db.query("DELETE FROM memories WHERE scope_id=$1 AND id=$2", [scopeId(scope), id]); return (result.rowCount ?? 0) > 0; }
}
const ingestionJobFields = "id,kind,status,checkpoint,attempts,max_attempts,input,next_attempt_at,lease_until,last_error,created_at,updated_at";
export class PostgresIngestionJobStore implements IngestionJobStore {
  constructor(private readonly db: PostgresDatabase) {}
  async create(input: CreateIngestionJobInput): Promise<IngestionJob> {
    const result = await this.db.query<IngestionJobRow>(`INSERT INTO ingestion_jobs(id,scope_id,kind,status,checkpoint,attempts,max_attempts,input,next_attempt_at) VALUES($1,$2,$3,'queued','queued',0,$4,$5::jsonb,now()) ON CONFLICT(scope_id,id) DO UPDATE SET status='queued',checkpoint='queued',attempts=0,max_attempts=EXCLUDED.max_attempts,input=EXCLUDED.input,next_attempt_at=now(),lease_until=NULL,last_error=NULL,updated_at=now() RETURNING ${ingestionJobFields}`, [input.id, scopeId(input.scope), input.kind, input.maxAttempts ?? 5, JSON.stringify(input.input)]);
    return rowToIngestionJob(result.rows[0]!);
  }
  async get(id: string, scope?: PlanetScope): Promise<IngestionJob | null> { const result = await this.db.query<IngestionJobRow>(`SELECT ${ingestionJobFields} FROM ingestion_jobs WHERE scope_id=$1 AND id=$2`, [scopeId(scope), id]); return result.rows[0] ? rowToIngestionJob(result.rows[0]) : null; }
  async update(input: UpdateIngestionJobInput): Promise<IngestionJob> {
    const values: unknown[] = [scopeId(input.scope), input.id]; const setters: string[] = [];
    const set = (field: string, value: unknown) => { values.push(value); setters.push(`${field}=$${values.length}`); };
    if (input.status !== undefined) set("status", input.status);
    if (input.checkpoint !== undefined) set("checkpoint", input.checkpoint);
    if (input.attempts !== undefined) set("attempts", input.attempts);
    if (input.nextAttemptAt !== undefined) set("next_attempt_at", input.nextAttemptAt);
    if (input.leaseUntil !== undefined) set("lease_until", input.leaseUntil);
    if (input.lastError !== undefined) set("last_error", input.lastError);
    if (input.input !== undefined) set("input", JSON.stringify(input.input));
    setters.push("updated_at=now()");
    const result = await this.db.query<IngestionJobRow>(`UPDATE ingestion_jobs SET ${setters.join(",")} WHERE scope_id=$1 AND id=$2 RETURNING ${ingestionJobFields}`, values);
    if (!result.rows[0]) throw new Error("Ingestion job does not exist in this scope.");
    return rowToIngestionJob(result.rows[0]);
  }
  async claimDue(input: { now?: Date; limit?: number; leaseMs?: number; scope?: PlanetScope }): Promise<IngestionJob[]> {
    const now = input.now ?? new Date(); const leaseUntil = new Date(now.getTime() + Math.max(1000, input.leaseMs ?? 60_000)); const currentScope = scopeId(input.scope);
    await this.db.query("UPDATE ingestion_jobs SET status='failed',lease_until=NULL,last_error=COALESCE(last_error,'Retry limit exceeded.'),updated_at=$2 WHERE scope_id=$1 AND attempts>=max_attempts AND ((status='retry_wait' AND next_attempt_at<=$2) OR (status='processing' AND lease_until<=$2))", [currentScope, now]);
    const result = await this.db.query<IngestionJobRow>(`WITH due AS (SELECT scope_id,id FROM ingestion_jobs WHERE scope_id=$1 AND attempts<max_attempts AND ((status IN ('queued','retry_wait') AND next_attempt_at<=$2) OR (status='processing' AND lease_until<=$2)) ORDER BY next_attempt_at,id LIMIT $3 FOR UPDATE SKIP LOCKED) UPDATE ingestion_jobs j SET status='processing',attempts=j.attempts+1,lease_until=$4,updated_at=$2 FROM due WHERE j.scope_id=due.scope_id AND j.id=due.id RETURNING ${[...ingestionJobFields.split(",")].map((field) => `j.${field}`).join(",")}`, [currentScope, now, Math.max(1, Math.min(input.limit ?? 10, 100)), leaseUntil]);
    return result.rows.map(rowToIngestionJob);
  }
}

type IdentityRow = { id: string; namespace: string; name: string; metadata: JsonObject; created_at: Date };
type BindingRow = { identity_id: string; provider_id: string; resource_type: string; resource_id: string; metadata: JsonObject; created_at: Date };
export class PostgresIdentityStore implements IdentityStore {
  private readonly identities: string; private readonly aliases: string; private readonly bindings: string;
  constructor(private readonly db: PostgresDatabase, schema = "public") { const prefix = identifier(schema); this.identities = `${prefix}.identities`; this.aliases = `${prefix}.identity_aliases`; this.bindings = `${prefix}.identity_bindings`; }
  async create(input: { namespace: string; name: string; metadata?: JsonObject; scope?: PlanetScope }): Promise<PlanetIdentity> { const row = await this.db.query<IdentityRow>(`INSERT INTO ${this.identities} (id,scope_id,namespace,name,metadata) VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING id,namespace,name,metadata,created_at`, [randomUUID(), scopeId(input.scope), input.namespace, input.name, JSON.stringify(input.metadata ?? {})]); return rowToIdentity(row.rows[0]!); }
  async resolveOrCreate(input: { namespace: string; name: string; canonicalName: string; fuzzyThreshold?: number; metadata?: JsonObject; scope?: PlanetScope }): Promise<PlanetIdentity> {
    if (!input.canonicalName.trim()) throw new Error("A canonical identity key cannot be empty.");
    if (!supportsTransactions(this.db)) throw new Error("Atomic identity resolution requires a transactional PostgreSQL pool.");
    const connection = await this.db.connect(); const currentScope = scopeId(input.scope);
    try {
      await connection.query("BEGIN");
      // Serialize resolution across the entire scoped entity namespace. A canonical-key lock
      // alone still lets two different fuzzy spellings create separate identities.
      await connection.query("SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))", [`${currentScope}:${input.namespace}`, "entity-resolution"]);
      const existing = await connection.query<IdentityRow & { alias: string | null }>(`SELECT i.id,i.namespace,i.name,i.metadata,i.created_at,a.alias FROM ${this.identities} i LEFT JOIN ${this.aliases} a ON a.scope_id=i.scope_id AND a.namespace=i.namespace AND a.identity_id=i.id WHERE i.scope_id=$1 AND i.namespace=$2 ORDER BY i.created_at,i.id FOR UPDATE OF i`, [currentScope, input.namespace]);
      const normalize = (value: string) => value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase().replace(/\b(incorporated|inc|corporation|corp|limited|ltd|llc|company|co)\b\.?/g, "").replace(/[^a-z0-9]/g, "");
      const similarity = (left: string, right: string) => { const a = normalize(left), b = normalize(right); if (a === b) return 1; if (!a || !b) return 0; let prev = Array.from({ length: b.length + 1 }, (_, i) => i); for (let i = 1; i <= a.length; i += 1) { let diag = prev[0]!; prev[0] = i; for (let j = 1; j <= b.length; j += 1) { const old = prev[j]!; prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1)); diag = old; } } return 1 - prev[b.length]! / Math.max(a.length, b.length); };
      const grouped = new Map<string, { row: IdentityRow; names: Set<string> }>();
      for (const row of existing.rows) { const group = grouped.get(row.id) ?? { row, names: new Set<string>() }; group.names.add(row.name); if (row.alias) group.names.add(row.alias); grouped.set(row.id, group); }
      const scored = [...grouped.values()].map((group) => ({ ...group, score: Math.max(...[...group.names].map((name) => similarity(name, input.name))) })).filter((group) => group.score >= (input.fuzzyThreshold ?? 0.9)).sort((a, b) => b.score - a.score || a.row.id.localeCompare(b.row.id));
      const best = scored.length && (scored.length === 1 || scored[0]!.score > scored[1]!.score) ? scored[0] : undefined;
      if (best) {
        if (!best.names.has(input.canonicalName) && input.canonicalName !== best.row.name) await connection.query(`INSERT INTO ${this.aliases} (scope_id,namespace,alias,identity_id) VALUES($1,$2,$3,$4) ON CONFLICT (scope_id,namespace,alias) DO NOTHING`, [currentScope, input.namespace, input.canonicalName, best.row.id]);
        await connection.query("COMMIT"); return rowToIdentity(best.row);
      }
      const created = await connection.query<IdentityRow>(`INSERT INTO ${this.identities} (id,scope_id,namespace,name,metadata) VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING id,namespace,name,metadata,created_at`, [randomUUID(), currentScope, input.namespace, input.name, JSON.stringify(input.metadata ?? {})]);
      const identity = rowToIdentity(created.rows[0]!);
      if (input.canonicalName !== identity.name) await connection.query(`INSERT INTO ${this.aliases} (scope_id,namespace,alias,identity_id) VALUES($1,$2,$3,$4) ON CONFLICT (scope_id,namespace,alias) DO NOTHING`, [currentScope, input.namespace, input.canonicalName, identity.id]);
      await connection.query("COMMIT"); return identity;
    } catch (error) { await connection.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { connection.release(); }
  }
  async get(input: { namespace: string; name: string; scope?: PlanetScope }): Promise<PlanetIdentity | null> { const row = await this.db.query<IdentityRow>(`SELECT id,namespace,name,metadata,created_at FROM ${this.identities} WHERE scope_id=$1 AND namespace=$2 AND name=$3`, [scopeId(input.scope), input.namespace, input.name]); return row.rows[0] ? rowToIdentity(row.rows[0]) : null; }
  async resolve(input: { namespace: string; name: string; scope?: PlanetScope }): Promise<PlanetIdentity | null> { const row = await this.db.query<IdentityRow>(`SELECT i.id,i.namespace,i.name,i.metadata,i.created_at FROM ${this.identities} i LEFT JOIN ${this.aliases} a ON a.identity_id=i.id AND a.scope_id=i.scope_id WHERE i.scope_id=$1 AND i.namespace=$2 AND (i.name=$3 OR a.alias=$3) ORDER BY (i.name=$3) DESC LIMIT 1`, [scopeId(input.scope), input.namespace, input.name]); return row.rows[0] ? rowToIdentity(row.rows[0]) : null; }
  async list(input: { namespace: string; limit?: number; scope?: PlanetScope }): Promise<PlanetIdentity[]> { const row = await this.db.query<IdentityRow>(`SELECT id,namespace,name,metadata,created_at FROM ${this.identities} WHERE scope_id=$1 AND namespace=$2 ORDER BY created_at,id LIMIT $3`, [scopeId(input.scope), input.namespace, Math.min(input.limit ?? 500, 100000)]); return row.rows.map(rowToIdentity); }
  async addAlias(input: { namespace: string; alias: string; identityId: string; scope?: PlanetScope }): Promise<void> { await this.db.query(`INSERT INTO ${this.aliases} (scope_id,namespace,alias,identity_id) SELECT $1,$2,$3,$4 WHERE EXISTS (SELECT 1 FROM ${this.identities} WHERE id=$4 AND scope_id=$1 AND namespace=$2)`, [scopeId(input.scope), input.namespace, input.alias, input.identityId]); }
  async bind(input: { identityId: string; providerId: string; resourceType: string; resourceId: string; metadata?: JsonObject; scope?: PlanetScope }): Promise<IdentityBinding> { const row = await this.db.query<BindingRow>(`INSERT INTO ${this.bindings} (scope_id,identity_id,provider_id,resource_type,resource_id,metadata) SELECT $1,$2,$3,$4,$5,$6::jsonb WHERE EXISTS (SELECT 1 FROM ${this.identities} WHERE id=$2 AND scope_id=$1) RETURNING identity_id,provider_id,resource_type,resource_id,metadata,created_at`, [scopeId(input.scope), input.identityId, input.providerId, input.resourceType, input.resourceId, JSON.stringify(input.metadata ?? {})]); if (!row.rows[0]) throw new Error("Identity must exist in this scope before it can be bound."); return rowToBinding(row.rows[0]); }
  async listBindings(input: { identityId: string; limit?: number; scope?: PlanetScope }): Promise<IdentityBinding[]> { const row = await this.db.query<BindingRow>(`SELECT identity_id,provider_id,resource_type,resource_id,metadata,created_at FROM ${this.bindings} WHERE scope_id=$1 AND identity_id=$2 ORDER BY created_at LIMIT $3`, [scopeId(input.scope), input.identityId, input.limit ?? 100]); return row.rows.map(rowToBinding); }
}
const rowToIdentity = (row: IdentityRow): PlanetIdentity => ({ id: row.id, namespace: row.namespace, name: row.name, metadata: row.metadata ?? {}, createdAt: row.created_at });
const rowToBinding = (row: BindingRow): IdentityBinding => ({ identityId: row.identity_id, providerId: row.provider_id, resourceType: row.resource_type, resourceId: row.resource_id, metadata: row.metadata ?? {}, createdAt: row.created_at });
export type VectorCollectionConfig = CoreVectorCollectionConfig;
export class PgVectorStore implements VectorStore {
  constructor(private readonly db: PostgresDatabase, private readonly collections: Readonly<Record<string, VectorCollectionConfig>> = {}) {}
  private validate(namespace: string, embedding: number[], model?: string) {
    const collection = this.collections[namespace];
    if (collection && embedding.length !== collection.dimensions) throw new EmbeddingDimensionMismatchError(collection.dimensions, embedding.length, model ?? collection.model ?? "unspecified", namespace);
    if (collection?.model && model && collection.model !== model) throw new Error(`Embedding model mismatch. Expected: ${collection.model}; received: ${model}; collection: ${namespace}.`);
  }
  async upsert(input: VectorRecord): Promise<void> {
    this.validate(input.namespace, input.embedding, input.model);
    const model = input.model ?? this.collections[input.namespace]?.model ?? null;
    await this.db.query(`INSERT INTO vectors (scope_id,id,namespace,model,dimensions,embedding,metadata) VALUES ($1,$2,$3,$4,$5,$6::vector,$7::jsonb) ON CONFLICT (scope_id,namespace,id) DO UPDATE SET model=EXCLUDED.model,dimensions=EXCLUDED.dimensions,embedding=EXCLUDED.embedding,metadata=EXCLUDED.metadata,updated_at=now()`, [scopeId(input.scope), input.id, input.namespace, model, input.embedding.length, vectorLiteral(input.embedding), JSON.stringify(input.metadata ?? {})]);
  }
  async search(input: VectorSearchInput): Promise<VectorSearchResult[]> {
    if (input.namespace) this.validate(input.namespace, input.embedding, input.model);
    const values: unknown[] = [scopeId(input.scope), vectorLiteral(input.embedding)]; const clauses = ["scope_id=$1"];
    if (input.namespace) { values.push(input.namespace); clauses.push(`namespace=$${values.length}`); }
    if (input.model) { values.push(input.model); clauses.push(`model=$${values.length}`); }
    if (input.metadata) { values.push(JSON.stringify(input.metadata)); clauses.push(`metadata @> $${values.length}::jsonb`); }
    values.push(input.limit ?? 20);
    const result = await this.db.query<{ id: string; namespace: string; score: number; metadata: JsonObject }>(`SELECT id,namespace,1-(embedding <=> $2::vector) AS score,metadata FROM vectors WHERE ${clauses.join(" AND ")} ORDER BY embedding <=> $2::vector,id LIMIT $${values.length}`, values);
    return result.rows;
  }
  async delete(input: { id: string; namespace: string; scope?: PlanetScope }): Promise<void> { await this.db.query("DELETE FROM vectors WHERE scope_id=$1 AND namespace=$2 AND id=$3", [scopeId(input.scope), input.namespace, input.id]); }
}
export function pgVectorCollectionIndexSql(namespace: string, dimensions: number, indexName = `vectors_${namespace.replace(/[^a-zA-Z0-9_]/g, "_")}_hnsw_idx`, schema = "public"): string { if (!Number.isInteger(dimensions) || dimensions < 1) throw new Error("Vector dimensions must be a positive integer."); const safeIndex = identifier(indexName.replaceAll("\"", "")); return `CREATE INDEX IF NOT EXISTS ${safeIndex} ON ${identifier(schema)}.vectors USING hnsw ((embedding::vector(${dimensions})) vector_cosine_ops) WHERE namespace = '${namespace.replaceAll("'", "''")}';`; }
export class PostgresSqlStore implements SqlStore {
  constructor(private readonly db: PostgresDatabase, private readonly schema = "public", private readonly transactionScoped = false) { identifier(schema); }
  async query<T extends Record<string, unknown> = Record<string, unknown>>(input: SqlQueryInput): Promise<SqlQueryResult<T>> {
    if (this.schema === "public" || this.transactionScoped) { const result = await this.db.query<T>(input.text, input.values); return { rows: result.rows, rowCount: result.rowCount ?? 0 }; }
    if (!supportsTransactions(this.db)) throw new Error("A non-public Planet schema requires a transactional PostgreSQL pool for SQL queries.");
    const connection = await this.db.connect();
    try { await connection.query("BEGIN"); await connection.query(`SET LOCAL search_path TO ${identifier(this.schema)}, public`); const result = await connection.query<T>(input.text, input.values); await connection.query("COMMIT"); return { rows: result.rows, rowCount: result.rowCount ?? 0 }; }
    catch (error) { await connection.query("ROLLBACK").catch(() => undefined); throw error; } finally { connection.release(); }
  }
  async transaction<T>(work: (transaction: SqlTransaction) => Promise<T>): Promise<T> {
    if (!supportsTransactions(this.db)) throw new Error("The configured PostgreSQL database does not support transactions. Pass a pg.Pool or compatible pooled client.");
    const connection = await this.db.connect();
    try { await connection.query("BEGIN"); if (this.schema !== "public") await connection.query(`SET LOCAL search_path TO ${identifier(this.schema)}, public`); const result = await work(new PostgresSqlStore(connection, this.schema, true)); await connection.query("COMMIT"); return result; }
    catch (error) { await connection.query("ROLLBACK").catch(() => undefined); throw error; } finally { connection.release(); }
  }
}
export function createPostgresProvider(input: { id?: string; database: PostgresDatabase; schema?: string; vectorCollections?: Record<string, VectorCollectionConfig> }): DataLayerProvider {
  const schema = input.schema ?? "public"; identifier(schema); const observedDatabase = instrumentPostgresDatabase(input.database); const database = schemaDatabase(observedDatabase, schema);
  return { id: input.id ?? "postgres", graph: new PostgresGraphStore(database), vector: new PgVectorStore(database, input.vectorCollections), vectorCollections: input.vectorCollections, documents: new PostgresDocumentStore(database), chunks: new PostgresDocumentChunkStore(database), evidence: new PostgresEvidenceStore(database), memories: new PostgresMemoryStore(database), ingestionJobs: new PostgresIngestionJobStore(database), identities: new PostgresIdentityStore(observedDatabase, schema), sql: new PostgresSqlStore(observedDatabase, schema) };
}
