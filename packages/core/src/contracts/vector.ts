import type { JsonObject, PlanetScope, ScopedInput } from "./common.js";

export interface VectorRecord extends ScopedInput { id: string; namespace: string; embedding: number[]; metadata?: JsonObject; model?: string }
export interface VectorSearchInput extends ScopedInput { embedding: number[]; namespace?: string; limit?: number; model?: string; metadata?: JsonObject }
export interface VectorSearchResult { id: string; namespace: string; score: number; metadata: JsonObject }
export interface VectorStore {
  upsert(input: VectorRecord): Promise<void>;
  search(input: VectorSearchInput): Promise<VectorSearchResult[]>;
  delete(input: { id: string; namespace: string; scope?: PlanetScope }): Promise<void>;
}
