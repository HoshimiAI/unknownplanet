import type { DocumentId, JsonObject, PlanetScope, ScopedInput } from "./common.js";

export interface PlanetDocument {
  id: DocumentId;
  externalId?: string;
  title: string;
  contentUri: string;
  metadata: JsonObject;
  createdAt: Date;
  updatedAt: Date;
}
export interface CreateDocumentInput extends ScopedInput { id?: DocumentId; externalId?: string; title: string; contentUri: string; metadata?: JsonObject }
export interface DocumentStore {
  create(input: CreateDocumentInput): Promise<PlanetDocument>;
  get(id: DocumentId, scope?: PlanetScope): Promise<PlanetDocument | null>;
  delete?(id: DocumentId, scope?: PlanetScope): Promise<boolean>;
}

export interface DocumentChunk {
  id: string; documentId: DocumentId; contentUri?: string; text?: string; startOffset?: number; endOffset?: number;
  metadata: JsonObject; createdAt: Date; updatedAt: Date;
}
export interface CreateDocumentChunkInput extends ScopedInput {
  id?: string; documentId: DocumentId; contentUri?: string; text?: string; startOffset?: number; endOffset?: number; metadata?: JsonObject;
}
export interface DocumentChunkStore {
  create(input: CreateDocumentChunkInput): Promise<DocumentChunk>;
  get(id: string, scope?: PlanetScope): Promise<DocumentChunk | null>;
  list(input: ScopedInput & { documentId: DocumentId; limit?: number }): Promise<DocumentChunk[]>;
  listPage?(input: ScopedInput & { documentId: DocumentId; limit?: number; afterId?: string }): Promise<{ items: DocumentChunk[]; hasMore: boolean }>;
  search(input: ScopedInput & { query: string; limit?: number }): Promise<DocumentChunk[]>;
  deleteExcept(input: ScopedInput & { documentId: DocumentId; keepIds: string[] }): Promise<number>;
}

export interface DocumentParser { parse(input: { data: Uint8Array; contentType: string }): Promise<string> | string }
