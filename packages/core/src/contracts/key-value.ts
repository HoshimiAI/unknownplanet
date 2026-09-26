import type { JsonValue, ScopedInput } from "./common.js";

export interface KeyValueEntry { value: JsonValue; expiresAt?: Date }
export interface KeyValueStore {
  get(input: ScopedInput & { namespace?: string; key: string }): Promise<KeyValueEntry | null>;
  set(input: ScopedInput & { namespace?: string; key: string; value: JsonValue; ttlMs?: number }): Promise<void>;
  delete(input: ScopedInput & { namespace?: string; key: string }): Promise<boolean>;
}
