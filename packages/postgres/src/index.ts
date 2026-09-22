import { randomUUID } from "node:crypto";
import type {
  AddEvidenceInput, CreateDocumentInput, CreateEdgeInput, CreateNodeInput, DocumentId,
  DocumentStore, EdgeId, Evidence, EvidenceListInput, EvidenceStore, GraphEdge, GraphNode,
  GraphStore, GraphTraversal, JsonObject, NeighborsInput, NodeId, PlanetDocument,
  TraverseInput, UpdateNodeInput, VectorRecord, VectorSearchInput, VectorSearchResult, VectorStore, DataLayerProvider, SqlQueryInput, SqlQueryResult, SqlStore, SqlTransaction,
} from "@unknown-planet/core";

/** The small surface required from `pg.Pool`, `pg.Client`, or a compatible driver. */
export interface PostgresDatabase {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

export interface PostgresConnection extends PostgresDatabase {
  release(): void;
}

/** Implemented by `pg.Pool` and compatible pooled clients. */
export interface PostgresTransactionalDatabase extends PostgresDatabase {
  connect(): Promise<PostgresConnection>;
}

function supportsTransactions(database: PostgresDatabase): database is PostgresTransactionalDatabase {
  return "connect" in database && typeof database.connect === "function";
}

type NodeRow = { id: string; type: string; name: string; properties: JsonObject; embedding: string | null; created_at: Date; updated_at: Date };
type EdgeRow = { id: string; source_id: string; target_id: string; relation: string; properties: JsonObject; confidence: number | null; created_at: Date; updated_at: Date };
type DocumentRow = { id: string; external_id: string | null; title: string; content_uri: string; metadata: JsonObject; created_at: Date; updated_at: Date };
type EvidenceRow = { id: string; edge_id: string; document_id: string; chunk_id: string | null; source_type: string | null; extractor: string; confidence: number | null; metadata: JsonObject; created_at: Date };

const nodes = "id, type, name, properties, embedding::text AS embedding, created_at, updated_at";
const edges = "id, source_id, target_id, relation, properties, confidence, created_at, updated_at";
const documents = "id, external_id, title, content_uri, metadata, created_at, updated_at";
const evidence = "id, edge_id, document_id, chunk_id, source_type, extractor, confidence, metadata, created_at";
const vectorLiteral = (value: number[]) => {
  if (value.length === 0 || value.some((component) => !Number.isFinite(component))) throw new Error("An embedding must contain finite numbers.");
  return `[${value.join(",")}]`;
};
const parseVector = (value: string | null): number[] | undefined => value === null ? undefined : JSON.parse(value.replaceAll("{", "[").replaceAll("}", "]")) as number[];
const node = (row: NodeRow): GraphNode => ({ id: row.id, type: row.type, name: row.name, properties: row.properties ?? {}, embedding: parseVector(row.embedding), createdAt: row.created_at, updatedAt: row.updated_at });
const edge = (row: EdgeRow): GraphEdge => ({ id: row.id, sourceId: row.source_id, targetId: row.target_id, relation: row.relation, properties: row.properties ?? {}, confidence: row.confidence ?? undefined, createdAt: row.created_at, updatedAt: row.updated_at });
const document = (row: DocumentRow): PlanetDocument => ({ id: row.id, externalId: row.external_id ?? undefined, title: row.title, contentUri: row.content_uri, metadata: row.metadata ?? {}, createdAt: row.created_at, updatedAt: row.updated_at });
const toEvidence = (row: EvidenceRow): Evidence => ({ id: row.id, edgeId: row.edge_id, documentId: row.document_id, chunkId: row.chunk_id ?? undefined, sourceType: row.source_type ?? undefined, extractor: row.extractor, confidence: row.confidence ?? undefined, metadata: row.metadata ?? {}, createdAt: row.created_at });

/** PostgreSQL property-graph adapter. Its SQL and pgvector representation never escape this package. */
export class PostgresGraphStore implements GraphStore {
  constructor(private readonly db: PostgresDatabase) {}

  async createNode(input: CreateNodeInput): Promise<GraphNode> {
    const result = await this.db.query<NodeRow>(`INSERT INTO nodes (id, type, name, properties, embedding)
      VALUES ($1, $2, $3, $4::jsonb, $5::vector) RETURNING ${nodes}`,
    [input.id ?? randomUUID(), input.type, input.name, JSON.stringify(input.properties ?? {}), input.embedding ? vectorLiteral(input.embedding) : null]);
    return node(result.rows[0]!);
  }
  async getNode(id: NodeId): Promise<GraphNode | null> {
    const result = await this.db.query<NodeRow>(`SELECT ${nodes} FROM nodes WHERE id = $1`, [id]);
    return result.rows[0] ? node(result.rows[0]) : null;
  }
  async updateNode(id: NodeId, input: UpdateNodeInput): Promise<GraphNode | null> {
    const fields: string[] = []; const values: unknown[] = [];
    const add = (sql: string, value: unknown) => { values.push(value); fields.push(`${sql} = $${values.length}`); };
    if (input.type !== undefined) add("type", input.type);
    if (input.name !== undefined) add("name", input.name);
    if (input.properties !== undefined) add("properties", JSON.stringify(input.properties));
    if (input.embedding !== undefined) add("embedding", input.embedding === null ? null : vectorLiteral(input.embedding));
    if (fields.length === 0) return this.getNode(id);
    values.push(id);
    const result = await this.db.query<NodeRow>(`UPDATE nodes SET ${fields.join(", ")}, updated_at = now() WHERE id = $${values.length} RETURNING ${nodes}`, values);
    return result.rows[0] ? node(result.rows[0]) : null;
  }
  async deleteNode(id: NodeId): Promise<boolean> {
    // Foreign keys in the supplied migration cascade incident edges and their evidence.
    const result = await this.db.query("DELETE FROM nodes WHERE id = $1", [id]);
    return (result.rowCount ?? 0) > 0;
  }
  async createEdge(input: CreateEdgeInput): Promise<GraphEdge> {
    const result = await this.db.query<EdgeRow>(`INSERT INTO edges (id, source_id, target_id, relation, properties, confidence)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6) RETURNING ${edges}`,
    [input.id ?? randomUUID(), input.from, input.to, input.relation, JSON.stringify(input.properties ?? {}), input.confidence ?? null]);
    return edge(result.rows[0]!);
  }
  async getEdge(id: EdgeId): Promise<GraphEdge | null> {
    const result = await this.db.query<EdgeRow>(`SELECT ${edges} FROM edges WHERE id = $1`, [id]);
    return result.rows[0] ? edge(result.rows[0]) : null;
  }
  async deleteEdge(id: EdgeId): Promise<boolean> {
    const result = await this.db.query("DELETE FROM edges WHERE id = $1", [id]);
    return (result.rowCount ?? 0) > 0;
  }
  async neighbors(input: NeighborsInput): Promise<GraphEdge[]> {
    const direction = input.direction ?? "both";
    const predicate = direction === "outbound" ? "source_id = $1" : direction === "inbound" ? "target_id = $1" : "(source_id = $1 OR target_id = $1)";
    const values: unknown[] = [input.nodeId];
    if (input.relation) values.push(input.relation);
    values.push(input.limit ?? 100);
    const relation = input.relation ? ` AND relation = $${values.length - 1}` : "";
    const result = await this.db.query<EdgeRow>(`SELECT ${edges} FROM edges WHERE ${predicate}${relation} ORDER BY created_at, id LIMIT $${values.length}`, values);
    return result.rows.map(edge);
  }
  async traverse(input: TraverseInput): Promise<GraphTraversal> {
    const limit = input.limit ?? 1000;
    const visited = new Map<string, number>(input.startIds.map((id) => [id, 0]));
    const foundEdges = new Map<string, GraphEdge>();
    let frontier = [...visited.keys()];
    for (let depth = 1; depth <= input.depth && frontier.length > 0 && visited.size < limit; depth += 1) {
      const next: string[] = [];
      for (const id of frontier) {
        const adjacent = await this.neighbors({ nodeId: id, direction: input.direction, relation: input.relation, limit });
        for (const item of adjacent) {
          foundEdges.set(item.id, item);
          const other = item.sourceId === id ? item.targetId : item.sourceId;
          if (!visited.has(other) && visited.size < limit) { visited.set(other, depth); next.push(other); }
        }
      }
      frontier = next;
    }
    const fetched = await Promise.all([...visited.keys()].map((id) => this.getNode(id)));
    return { nodes: fetched.filter((item): item is GraphNode => item !== null), edges: [...foundEdges.values()], depthByNode: Object.fromEntries(visited) };
  }
  async searchNodes(input: { query: string; limit?: number }): Promise<GraphNode[]> {
    const result = await this.db.query<NodeRow>(`SELECT ${nodes} FROM nodes
      WHERE name ILIKE '%' || $1 || '%' OR properties::text ILIKE '%' || $1 || '%'
      ORDER BY CASE WHEN lower(name) = lower($1) THEN 0 ELSE 1 END, name, id LIMIT $2`, [input.query, input.limit ?? 20]);
    return result.rows.map(node);
  }
}

export class PostgresDocumentStore implements DocumentStore {
  constructor(private readonly db: PostgresDatabase) {}
  async create(input: CreateDocumentInput): Promise<PlanetDocument> {
    const result = await this.db.query<DocumentRow>(`INSERT INTO documents (id, external_id, title, content_uri, metadata)
      VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING ${documents}`,
    [input.id ?? randomUUID(), input.externalId ?? null, input.title, input.contentUri, JSON.stringify(input.metadata ?? {})]);
    return document(result.rows[0]!);
  }
  async get(id: DocumentId): Promise<PlanetDocument | null> {
    const result = await this.db.query<DocumentRow>(`SELECT ${documents} FROM documents WHERE id = $1`, [id]);
    return result.rows[0] ? document(result.rows[0]) : null;
  }
}

export class PostgresEvidenceStore implements EvidenceStore {
  constructor(private readonly db: PostgresDatabase) {}
  async add(input: AddEvidenceInput): Promise<Evidence> {
    const result = await this.db.query<EvidenceRow>(`INSERT INTO evidence (id, edge_id, document_id, chunk_id, source_type, extractor, confidence, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb) RETURNING ${evidence}`,
    [input.id ?? randomUUID(), input.edgeId, input.documentId, input.chunkId ?? null, input.sourceType ?? null, input.extractor, input.confidence ?? null, JSON.stringify(input.metadata ?? {})]);
    return toEvidence(result.rows[0]!);
  }
  async list(input: EvidenceListInput): Promise<Evidence[]> {
    const values: unknown[] = []; const clauses: string[] = [];
    if (input.edgeId) { values.push(input.edgeId); clauses.push(`edge_id = $${values.length}`); }
    if (input.edgeIds?.length) { values.push(input.edgeIds); clauses.push(`edge_id = ANY($${values.length}::uuid[])`); }
    if (input.documentId) { values.push(input.documentId); clauses.push(`document_id = $${values.length}`); }
    values.push(input.limit ?? 100);
    const result = await this.db.query<EvidenceRow>(`SELECT ${evidence} FROM evidence ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY created_at, id LIMIT $${values.length}`, values);
    return result.rows.map(toEvidence);
  }
}

/** Generic pgvector adapter. Callers choose namespaces such as `node` and `document`. */
export class PgVectorStore implements VectorStore {
  constructor(private readonly db: PostgresDatabase) {}
  async upsert(input: VectorRecord): Promise<void> {
    await this.db.query(`INSERT INTO vectors (id, namespace, embedding, metadata) VALUES ($1, $2, $3::vector, $4::jsonb)
      ON CONFLICT (id) DO UPDATE SET namespace = EXCLUDED.namespace, embedding = EXCLUDED.embedding, metadata = EXCLUDED.metadata, updated_at = now()`,
    [input.id, input.namespace, vectorLiteral(input.embedding), JSON.stringify(input.metadata ?? {})]);
  }
  async search(input: VectorSearchInput): Promise<VectorSearchResult[]> {
    const values: unknown[] = [vectorLiteral(input.embedding)];
    const where = input.namespace ? (values.push(input.namespace), "WHERE namespace = $2") : "";
    values.push(input.limit ?? 20);
    const result = await this.db.query<{ id: string; namespace: string; score: number; metadata: JsonObject }>(`SELECT id, namespace, 1 - (embedding <=> $1::vector) AS score, metadata FROM vectors ${where} ORDER BY embedding <=> $1::vector, id LIMIT $${values.length}`, values);
    return result.rows;
  }
  async delete(id: string): Promise<void> { await this.db.query("DELETE FROM vectors WHERE id = $1", [id]); }
}

/** Parameterized SQL access for normal relational application tables. */
export class PostgresSqlStore implements SqlStore {
  constructor(private readonly db: PostgresDatabase) {}
  async query<T extends Record<string, unknown> = Record<string, unknown>>(input: SqlQueryInput): Promise<SqlQueryResult<T>> {
    const result = await this.db.query<T>(input.text, input.values);
    return { rows: result.rows, rowCount: result.rowCount ?? 0 };
  }
  async transaction<T>(work: (transaction: SqlTransaction) => Promise<T>): Promise<T> {
    if (!supportsTransactions(this.db)) {
      throw new Error("The configured PostgreSQL database does not support transactions. Pass a pg.Pool or compatible pooled client.");
    }
    const connection = await this.db.connect();
    try {
      await connection.query("BEGIN");
      const result = await work(new PostgresSqlStore(connection));
      await connection.query("COMMIT");
      return result;
    } catch (error) {
      await connection.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
  }
}

/** Creates a complete PostgreSQL provider suitable for Planet's provider registry. */
export function createPostgresProvider(input: { id?: string; database: PostgresDatabase }): DataLayerProvider {
  return {
    id: input.id ?? "postgres",
    graph: new PostgresGraphStore(input.database),
    vector: new PgVectorStore(input.database),
    documents: new PostgresDocumentStore(input.database),
    evidence: new PostgresEvidenceStore(input.database),
    sql: new PostgresSqlStore(input.database),
  };
}
