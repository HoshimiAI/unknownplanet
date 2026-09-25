import type { CreateNodeInput, DocumentChunkStore, DocumentParser, DocumentStore, EmbeddingProvider, EntityExtractor, EvidenceStore, GraphNode, GraphStore, MemoryStore, PlanetIdentity, PlanetScope, ProviderOperation, VectorStore } from "@unknown-planet/core";
import type { RetrievalConfig } from "../../types.js";

export interface KnowledgeIngestionContext {
  scope: PlanetScope;
  embeddingProvider?: EmbeddingProvider;
  entityExtractor?: EntityExtractor;
  documentParsers: Record<string, DocumentParser>;
  retrieval: RetrievalConfig;
  requireDocuments(operation: ProviderOperation): DocumentStore;
  requireChunks(operation: ProviderOperation): DocumentChunkStore;
  requireVector(operation: ProviderOperation): VectorStore;
  resolveVector(operation: ProviderOperation): VectorStore | undefined;
  requireGraph(operation: ProviderOperation): GraphStore;
  requireEvidence(operation: ProviderOperation): EvidenceStore;
  resolveEvidence(operation: ProviderOperation): EvidenceStore | undefined;
  requireMemories(operation: ProviderOperation): MemoryStore;
  parse(parser: DocumentParser, data: Uint8Array, contentType: string): Promise<string>;
  embed(text: string, collections?: string[]): Promise<number[]>;
  embedMany(texts: string[], collection?: string): Promise<number[][]>;
  extractEntities(text: string): Promise<Array<{ name: string; type: string; aliases: string[] }>>;
  resolveEntityIdentity(entity: { name: string; type: string; aliases: string[] }): Promise<PlanetIdentity | null>;
  createGraphNode(input: CreateNodeInput): Promise<GraphNode>;
}
