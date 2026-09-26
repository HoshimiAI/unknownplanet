import type { JsonObject, PlanetScope, ScopedInput } from "./common.js";

export type IngestionJobStatus = "queued" | "processing" | "retry_wait" | "succeeded" | "failed";
export type IngestionCheckpoint = "queued" | "parsed" | "document_saved" | "chunks_saved" | "vectors_saved" | "knowledge_saved" | "memory_saved" | "completed";
export interface IngestionJob extends ScopedInput {
  id: string; kind: "document" | "memory"; status: IngestionJobStatus; checkpoint: IngestionCheckpoint; attempts: number; maxAttempts: number;
  input: JsonObject; nextAttemptAt?: Date; leaseUntil?: Date; leaseToken?: string; lastError?: string; createdAt: Date; updatedAt: Date;
}
export interface CreateIngestionJobInput extends ScopedInput { id: string; kind: "document" | "memory"; input: JsonObject; maxAttempts?: number }
export interface UpdateIngestionJobInput extends ScopedInput { id: string; status?: IngestionJobStatus; checkpoint?: IngestionCheckpoint; attempts?: number; input?: JsonObject; nextAttemptAt?: Date | null; leaseUntil?: Date | null; leaseToken?: string | null; expectedLeaseToken?: string; lastError?: string | null }
export interface IngestionJobStore {
  create(input: CreateIngestionJobInput): Promise<IngestionJob>;
  get(id: string, scope?: PlanetScope): Promise<IngestionJob | null>;
  update(input: UpdateIngestionJobInput): Promise<IngestionJob>;
  /** Atomically claim a newly created or expired specific job. */
  claim(input: ScopedInput & { id: string; leaseMs?: number }): Promise<IngestionJob>;
  claimDue(input: ScopedInput & { now?: Date; limit?: number; leaseMs?: number }): Promise<IngestionJob[]>;
}
