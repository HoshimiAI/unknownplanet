import type { JsonValue, ScopedInput } from "./common.js";

export interface StackStore {
  push(input: ScopedInput & { stack: string; value: JsonValue }): Promise<void>;
  pop(input: ScopedInput & { stack: string }): Promise<JsonValue | null>;
  peek(input: ScopedInput & { stack: string }): Promise<JsonValue | null>;
  size(input: ScopedInput & { stack: string }): Promise<number>;
}
