import type { DocumentId, JsonObject, PlanetScope, ScopedInput } from "./common.js";

export type MemoryType = "fact" | "observation" | "episode" | "decision" | "preference" | "instruction" | "summary";
export interface MemorySource { type: string; id: string; documentId?: DocumentId; chunkId?: string }
export interface MemoryRecord extends ScopedInput {
  id: string; agentId: string; content: string; type: MemoryType; userId?: string; sessionId?: string;
  importance?: number; confidence?: number; source?: MemorySource; metadata: JsonObject; createdAt: Date; updatedAt: Date;
}
export interface AddMemoryInput extends ScopedInput {
  id?: string; agentId: string; content: string; type?: MemoryType; userId?: string; sessionId?: string;
  importance?: number; confidence?: number; source?: MemorySource; metadata?: JsonObject;
}
export interface MemorySearchInput extends ScopedInput {
  agentId?: string; userId?: string; sessionId?: string; query?: string; limit?: number;
  type?: MemoryType; metadata?: JsonObject;
}
export interface MemoryStore {
  add(input: AddMemoryInput): Promise<MemoryRecord>;
  get(id: string, scope?: PlanetScope): Promise<MemoryRecord | null>;
  search(input: MemorySearchInput): Promise<MemoryRecord[]>;
  searchPage?(input: MemorySearchInput & { afterId?: string }): Promise<{ items: MemoryRecord[]; hasMore: boolean }>;
  delete(id: string, scope?: PlanetScope): Promise<boolean>;
}

export interface ExtractedEntity { name: string; type: string; aliases?: string[] }
export interface EntityExtractor { extract(input: { text: string }): Promise<ExtractedEntity[]> }
