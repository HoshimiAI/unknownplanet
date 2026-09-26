import type { JsonValue, ScopedInput } from "./common.js";

export interface QueueMessage { id: string; queue: string; value: JsonValue; attempts: number; availableAt: Date; }
export interface ClaimedQueueMessage extends QueueMessage { leaseToken: string; leaseUntil: Date }
export interface QueueStore {
  enqueue(input: ScopedInput & { queue: string; value: JsonValue; delayMs?: number }): Promise<QueueMessage>;
  claim(input: ScopedInput & { queue: string; limit?: number; leaseMs?: number }): Promise<ClaimedQueueMessage[]>;
  ack(input: ScopedInput & { queue: string; id: string; leaseToken: string }): Promise<boolean>;
  release(input: ScopedInput & { queue: string; id: string; leaseToken: string; delayMs?: number }): Promise<boolean>;
}
