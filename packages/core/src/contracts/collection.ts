/** Queries application-owned collections. The application creates collections and indexes. */
export interface CollectionStore {
  find<T extends Record<string, unknown> = Record<string, unknown>>(input: { collection: string; filter?: Record<string, unknown>; limit?: number }): Promise<T[]>;
  insertOne(input: { collection: string; document: Record<string, unknown> }): Promise<{ insertedId: unknown }>;
  updateOne(input: { collection: string; filter: Record<string, unknown>; update: Record<string, unknown> }): Promise<{ matchedCount: number; modifiedCount: number }>;
  deleteOne(input: { collection: string; filter: Record<string, unknown> }): Promise<{ deletedCount: number }>;
}
