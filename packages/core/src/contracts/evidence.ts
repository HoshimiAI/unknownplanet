import type { DocumentId, EdgeId, EvidenceId, JsonObject, ScopedInput } from "./common.js";

export interface Evidence {
  id: EvidenceId;
  edgeId: EdgeId;
  documentId?: DocumentId;
  sourceId?: string;
  chunkId?: string;
  sourceType?: string;
  extractor: string;
  confidence?: number;
  direction?: "support" | "contradict" | "neutral";
  strength?: number;
  metadata: JsonObject;
  createdAt: Date;
}
export interface AddEvidenceInput extends ScopedInput {
  id?: EvidenceId; edgeId: EdgeId; documentId?: DocumentId; sourceId?: string; chunkId?: string;
  sourceType?: string; extractor: string; confidence?: number; direction?: Evidence["direction"]; strength?: number; metadata?: JsonObject;
}
export interface EvidenceListInput extends ScopedInput { edgeId?: EdgeId; edgeIds?: EdgeId[]; documentId?: DocumentId; sourceId?: string; limit?: number }
export interface EvidenceStore { add(input: AddEvidenceInput): Promise<Evidence>; list(input: EvidenceListInput): Promise<Evidence[]>; listPage?(input: EvidenceListInput & { afterId?: string }): Promise<{ items: Evidence[]; hasMore: boolean }>; deleteByDocument?(input: ScopedInput & { documentId: DocumentId }): Promise<number>; deleteByChunks?(input: ScopedInput & { chunkIds: string[] }): Promise<number> }
