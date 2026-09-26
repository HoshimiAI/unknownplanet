import type { DataLayerProvider, JsonObject, PlanetScope, ProviderSchemaMap, VectorCollectionConfig, VectorRecord, VectorSearchInput, VectorSearchResult, VectorStore } from "@unknown-planet/core";

export interface QdrantPoint { id: string | number; score: number; payload?: Record<string, unknown> | null }
/** Structural subset of @qdrant/js-client-rest using its current query API. */
export interface QdrantClient {
  getCollections(): Promise<{ collections: Array<{ name: string }> }>;
  createCollection(name: string, config: { vectors: { size: number; distance: "Cosine" | "Dot" | "Euclid" | "Manhattan" } }): Promise<unknown>;
  upsert(name: string, input: { points: Array<{ id: string; vector: number[]; payload: Record<string, unknown> }>; wait?: boolean }): Promise<unknown>;
  query(name: string, input: { query: number[]; filter: { must: Array<Record<string, unknown>> }; limit: number; with_payload: boolean }): Promise<{ points: QdrantPoint[] }>;
  delete(name: string, input: { points: string[]; wait?: boolean }): Promise<unknown>;
}

export interface QdrantNamedCollection extends VectorCollectionConfig { collection: string; distance?: "Cosine" | "Dot" | "Euclid" | "Manhattan" }
const scopeId = (scope?: PlanetScope) => JSON.stringify([scope?.tenantId ?? "default", scope?.workspaceId ?? null]);
const hashId = async (value: string): Promise<string> => { const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))); bytes[6] = (bytes[6]! & 0x0f) | 0x50; bytes[8] = (bytes[8]! & 0x3f) | 0x80; const hex = [...bytes.slice(0, 16)].map((part) => part.toString(16).padStart(2, "0")).join(""); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`; };
const asJsonObject = (value: unknown): JsonObject => value && typeof value === "object" ? value as JsonObject : {};

export class QdrantVectorStore implements VectorStore {
  constructor(private readonly client: QdrantClient, private readonly collections: Readonly<Record<string, QdrantNamedCollection>>) {}
  private config(namespace?: string): QdrantNamedCollection { const value = namespace ? this.collections[namespace] : undefined; if (!value) throw new Error(`No Qdrant collection is configured for vector namespace '${namespace ?? "(missing)"}'.`); return value; }
  private async id(scope: PlanetScope | undefined, namespace: string, id: string) { return hashId(JSON.stringify([scopeId(scope), namespace, id])); }
  async upsert(input: VectorRecord): Promise<void> { const config = this.config(input.namespace); if (input.embedding.length !== config.dimensions || input.embedding.some((value) => !Number.isFinite(value))) throw new Error(`Vector namespace '${input.namespace}' requires ${config.dimensions} finite dimensions.`); const id = await this.id(input.scope, input.namespace, input.id); await this.client.upsert(config.collection, { wait: true, points: [{ id, vector: input.embedding, payload: { _up_scope: scopeId(input.scope), _up_namespace: input.namespace, _up_id: input.id, _up_model: input.model ?? config.model ?? "", metadata: input.metadata ?? {} } }] }); }
  async search(input: VectorSearchInput): Promise<VectorSearchResult[]> { const namespace = input.namespace; const config = this.config(namespace); if (input.embedding.length !== config.dimensions || input.embedding.some((value) => !Number.isFinite(value))) throw new Error(`Vector namespace '${namespace}' requires ${config.dimensions} finite dimensions.`); const must: Array<Record<string, unknown>> = [{ key: "_up_scope", match: { value: scopeId(input.scope) } }, { key: "_up_namespace", match: { value: namespace } }]; const model = input.model ?? config.model; if (model) must.push({ key: "_up_model", match: { value: model } }); for (const [key, value] of Object.entries(input.metadata ?? {})) must.push({ key: `metadata.${key}`, match: { value } }); const result = await this.client.query(config.collection, { query: input.embedding, filter: { must }, limit: Math.max(1, Math.min(input.limit ?? 20, 10000)), with_payload: true }); return result.points.map((point) => { const payload = point.payload ?? {}; return { id: String(payload._up_id ?? point.id), namespace: String(payload._up_namespace ?? namespace), score: point.score, metadata: asJsonObject(payload.metadata) }; }); }
  async delete(input: { id: string; namespace: string; scope?: PlanetScope }): Promise<void> { const config = this.config(input.namespace); const pointId = await this.id(input.scope, input.namespace, input.id); await this.client.delete(config.collection, { points: [pointId], wait: true }); }
}

function mapCollections(collections: Readonly<Record<string, QdrantNamedCollection>>, schemas: ProviderSchemaMap = {}) {
  const prefix = schemas.vector?.replace(/^_+|_+$/g, "") ?? "";
  if (prefix && !/^[A-Za-z0-9_-]+$/.test(prefix)) throw new Error("Qdrant vector namespace must contain only letters, numbers, underscores, or hyphens.");
  return Object.fromEntries(Object.entries(collections).map(([namespace, config]) => [namespace, { ...config, collection: prefix ? `${prefix}_${config.collection}` : config.collection }]));
}
/** Create configured Qdrant collections before serving traffic; existing collections are left intact. */
export async function initializeQdrantCollections(client: QdrantClient, input: Readonly<Record<string, QdrantNamedCollection>>, schemas: ProviderSchemaMap = {}): Promise<void> { const collections = mapCollections(input, schemas); const current = new Set((await client.getCollections()).collections.map((item) => item.name)); const byCollection = new Map<string, QdrantNamedCollection>(); for (const [namespace, config] of Object.entries(collections)) { if (!config.collection.trim() || !Number.isInteger(config.dimensions) || config.dimensions < 1) throw new Error(`Qdrant namespace '${namespace}' requires a collection name and positive dimensions.`); const prior = byCollection.get(config.collection); if (prior && (prior.dimensions !== config.dimensions || (prior.distance ?? "Cosine") !== (config.distance ?? "Cosine"))) throw new Error(`Qdrant collection '${config.collection}' cannot be configured with different dimensions or distance functions.`); byCollection.set(config.collection, config); } for (const [name, config] of byCollection) if (!current.has(name)) await client.createCollection(name, { vectors: { size: config.dimensions, distance: config.distance ?? "Cosine" } }); }
export function createQdrantProvider(input: { id?: string; client: QdrantClient; collections: Readonly<Record<string, QdrantNamedCollection>>; schemas?: ProviderSchemaMap }): DataLayerProvider {
  const collections = mapCollections(input.collections, input.schemas);
  const vectorCollections = Object.fromEntries(Object.entries(collections).map(([namespace, config]) => [namespace, { dimensions: config.dimensions, model: config.model }]));
  return { id: input.id ?? "qdrant", vector: new QdrantVectorStore(input.client, collections), vectorCollections };
}
