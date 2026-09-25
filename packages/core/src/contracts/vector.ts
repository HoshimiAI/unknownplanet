import type { JsonObject, PlanetScope, ScopedInput } from "./common.js";

export interface VectorRecord extends ScopedInput { id: string; namespace: string; embedding: number[]; metadata?: JsonObject; model?: string }
export interface VectorSearchInput extends ScopedInput { embedding: number[]; namespace?: string; limit?: number; model?: string; metadata?: JsonObject }
export interface VectorSearchResult { id: string; namespace: string; score: number; metadata: JsonObject }
export class EmbeddingDimensionMismatchError extends Error {
  readonly code = "embedding_dimension_mismatch";
  readonly statusCode = 400;
  constructor(readonly expected: number, readonly received: number, readonly model: string, readonly collection: string) {
    super(`Embedding dimension mismatch. Expected: ${expected}; received: ${received}; model: ${model}; collection: ${collection}.`);
    this.name = "EmbeddingDimensionMismatchError";
  }
}
export interface VectorStore {
  upsert(input: VectorRecord): Promise<void>;
  search(input: VectorSearchInput): Promise<VectorSearchResult[]>;
  delete(input: { id: string; namespace: string; scope?: PlanetScope }): Promise<void>;
}
