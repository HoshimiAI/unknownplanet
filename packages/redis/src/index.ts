import type { ClaimedQueueMessage, DataLayerProvider, JsonValue, KeyValueStore, PlanetScope, ProviderSchemaMap, QueueMessage, QueueStore, StackStore } from "@unknown-planet/core";

/** Structural subset of node-redis v4/v5; keeping it structural makes redis a consumer-owned peer dependency. */
export interface RedisCommandClient { sendCommand(args: string[]): Promise<unknown> }

const resultString = (value: unknown): string => typeof value === "string" ? value : value instanceof Uint8Array ? new TextDecoder().decode(value) : String(value);
const numberResult = (value: unknown): number => Number(resultString(value));
const encodePart = (value: string) => encodeURIComponent(value);
const scopedPart = (scope?: PlanetScope) => `t${encodePart(scope?.tenantId ?? "default")}%w${encodePart(scope?.workspaceId ?? "")}`;
const assertName = (value: string, label: string) => { if (!value.trim()) throw new Error(`${label} cannot be empty.`); };

const claimScript = `
local expired = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', ARGV[1])
for _, id in ipairs(expired) do
  redis.call('ZREM', KEYS[2], id)
  local raw = redis.call('HGET', KEYS[3], id)
  if raw then
    local message = cjson.decode(raw)
    message.leaseToken = nil
    message.leaseUntil = nil
    redis.call('HSET', KEYS[3], id, cjson.encode(message))
    redis.call('ZADD', KEYS[1], message.availableAt, id)
  else
    redis.call('ZREM', KEYS[1], id)
  end
end
local ids = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, ARGV[3])
local output = {}
for _, id in ipairs(ids) do
  local raw = redis.call('HGET', KEYS[3], id)
  if raw then
    local message = cjson.decode(raw)
    message.attempts = message.attempts + 1
    message.leaseUntil = tonumber(ARGV[1]) + tonumber(ARGV[2])
    message.leaseToken = ARGV[4]
    redis.call('ZREM', KEYS[1], id)
    redis.call('ZADD', KEYS[2], message.leaseUntil, id)
    local encoded = cjson.encode(message)
    redis.call('HSET', KEYS[3], id, encoded)
    table.insert(output, id)
    table.insert(output, encoded)
  end
end
return output`;

const enqueueScript = `
local id = string.format('%020d', redis.call('INCR', KEYS[3]))
local message = cjson.decode(ARGV[1])
message.availableAt = tonumber(ARGV[2])
redis.call('HSET', KEYS[2], id, cjson.encode(message))
redis.call('ZADD', KEYS[1], message.availableAt, id)
return id`;

const ackScript = `
local untilTime = redis.call('ZSCORE', KEYS[1], ARGV[1])
if not untilTime or tonumber(untilTime) <= tonumber(ARGV[3]) then return 0 end
local raw = redis.call('HGET', KEYS[2], ARGV[1])
if not raw or cjson.decode(raw).leaseToken ~= ARGV[2] then return 0 end
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('HDEL', KEYS[2], ARGV[1])
return 1`;

const releaseScript = `
local untilTime = redis.call('ZSCORE', KEYS[1], ARGV[1])
if not untilTime or tonumber(untilTime) <= tonumber(ARGV[3]) then return 0 end
local raw = redis.call('HGET', KEYS[2], ARGV[1])
if not raw then redis.call('ZREM', KEYS[1], ARGV[1]); return 0 end
local message = cjson.decode(raw)
if message.leaseToken ~= ARGV[2] then return 0 end
message.availableAt = tonumber(ARGV[3]) + tonumber(ARGV[4])
message.leaseUntil = nil
message.leaseToken = nil
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('HSET', KEYS[2], ARGV[1], cjson.encode(message))
redis.call('ZADD', KEYS[3], message.availableAt, ARGV[1])
return 1`;

export class RedisQueueStore implements QueueStore {
  constructor(private readonly client: RedisCommandClient, private readonly prefix = "unknownplanet") {}
  private keys(queue: string, scope?: PlanetScope) { const tag = `{${scopedPart(scope)}%q${encodePart(queue)}}`; const base = `${this.prefix}:queue:${tag}`; return [`${base}:ready`, `${base}:leased`, `${base}:data`, `${base}:sequence`]; }
  async enqueue(input: { queue: string; value: JsonValue; delayMs?: number; scope?: PlanetScope }): Promise<QueueMessage> {
    assertName(input.queue, "Queue name"); const delay = input.delayMs ?? 0; if (!Number.isFinite(delay) || delay < 0) throw new Error("Queue delayMs must be a non-negative number.");
    const [ready, , data, sequence] = this.keys(input.queue, input.scope); const availableAt = Date.now() + Math.ceil(delay); const id = resultString(await this.client.sendCommand(["EVAL", enqueueScript, "3", ready, data, sequence, JSON.stringify({ value: input.value, attempts: 0 }), String(availableAt)]));
    return { id, queue: input.queue, value: input.value, attempts: 0, availableAt: new Date(availableAt) };
  }
  async claim(input: { queue: string; limit?: number; leaseMs?: number; scope?: PlanetScope }): Promise<ClaimedQueueMessage[]> {
    assertName(input.queue, "Queue name"); const rawLimit = input.limit ?? 1; const leaseMs = input.leaseMs ?? 60_000; if (!Number.isFinite(rawLimit) || !Number.isFinite(leaseMs)) throw new Error("Queue limit and leaseMs must be finite numbers."); const limit = Math.max(1, Math.min(Math.floor(rawLimit), 100)); const lease = Math.max(1000, Math.floor(leaseMs)); const [ready, leased, data] = this.keys(input.queue, input.scope);
    const raw = await this.client.sendCommand(["EVAL", claimScript, "3", ready, leased, data, String(Date.now()), String(lease), String(limit), crypto.randomUUID()]);
    if (!Array.isArray(raw)) throw new Error("Redis returned an invalid queue claim response."); const messages: ClaimedQueueMessage[] = [];
    for (let index = 0; index + 1 < raw.length; index += 2) { const id = resultString(raw[index]); const value = JSON.parse(resultString(raw[index + 1])) as { value: JsonValue; attempts: number; availableAt: number; leaseToken: string; leaseUntil: number }; messages.push({ id, queue: input.queue, value: value.value, attempts: value.attempts, availableAt: new Date(value.availableAt), leaseToken: value.leaseToken, leaseUntil: new Date(value.leaseUntil) }); }
    return messages;
  }
  async ack(input: { queue: string; id: string; leaseToken: string; scope?: PlanetScope }): Promise<boolean> { const [, leased, data] = this.keys(input.queue, input.scope); return numberResult(await this.client.sendCommand(["EVAL", ackScript, "2", leased, data, input.id, input.leaseToken, String(Date.now())])) === 1; }
  async release(input: { queue: string; id: string; leaseToken: string; delayMs?: number; scope?: PlanetScope }): Promise<boolean> { const delay = input.delayMs ?? 0; if (!Number.isFinite(delay) || delay < 0) throw new Error("Queue delayMs must be a non-negative number."); const [ready, leased, data] = this.keys(input.queue, input.scope); return numberResult(await this.client.sendCommand(["EVAL", releaseScript, "3", leased, data, ready, input.id, input.leaseToken, String(Date.now()), String(Math.ceil(delay))])) === 1; }
}

export class RedisStackStore implements StackStore {
  constructor(private readonly client: RedisCommandClient, private readonly prefix = "unknownplanet") {}
  private key(stack: string, scope?: PlanetScope) { return `${this.prefix}:stack:${scopedPart(scope)}:${encodePart(stack)}`; }
  async push(input: { stack: string; value: JsonValue; scope?: PlanetScope }): Promise<void> { assertName(input.stack, "Stack name"); await this.client.sendCommand(["LPUSH", this.key(input.stack, input.scope), JSON.stringify(input.value)]); }
  async pop(input: { stack: string; scope?: PlanetScope }): Promise<JsonValue | null> { assertName(input.stack, "Stack name"); const value = await this.client.sendCommand(["LPOP", this.key(input.stack, input.scope)]); return value === null ? null : JSON.parse(resultString(value)) as JsonValue; }
  async peek(input: { stack: string; scope?: PlanetScope }): Promise<JsonValue | null> { assertName(input.stack, "Stack name"); const value = await this.client.sendCommand(["LINDEX", this.key(input.stack, input.scope), "0"]); return value === null ? null : JSON.parse(resultString(value)) as JsonValue; }
  async size(input: { stack: string; scope?: PlanetScope }): Promise<number> { assertName(input.stack, "Stack name"); return numberResult(await this.client.sendCommand(["LLEN", this.key(input.stack, input.scope)])); }
}

export class RedisKeyValueStore implements KeyValueStore {
  constructor(private readonly client: RedisCommandClient, private readonly prefix = "unknownplanet") {}
  private key(namespace: string | undefined, key: string, scope?: PlanetScope) { return `${this.prefix}:kv:${scopedPart(scope)}:${encodePart(namespace ?? "default")}:${encodePart(key)}`; }
  async get(input: { namespace?: string; key: string; scope?: PlanetScope }): Promise<{ value: JsonValue; expiresAt?: Date } | null> { assertName(input.key, "Key"); const raw = await this.client.sendCommand(["GET", this.key(input.namespace, input.key, input.scope)]); if (raw === null) return null; const entry = JSON.parse(resultString(raw)) as { value: JsonValue; expiresAt?: string }; return { value: entry.value, expiresAt: entry.expiresAt ? new Date(entry.expiresAt) : undefined }; }
  async set(input: { namespace?: string; key: string; value: JsonValue; ttlMs?: number; scope?: PlanetScope }): Promise<void> { assertName(input.key, "Key"); const ttl = input.ttlMs; if (ttl !== undefined && (!Number.isFinite(ttl) || ttl < 0)) throw new Error("Key/value ttlMs must be a non-negative number."); const key = this.key(input.namespace, input.key, input.scope); if (ttl === 0) { await this.client.sendCommand(["DEL", key]); return; } const expiresAt = ttl === undefined ? undefined : new Date(Date.now() + Math.ceil(ttl)); const value = JSON.stringify({ value: input.value, expiresAt }); if (ttl === undefined) await this.client.sendCommand(["SET", key, value]); else await this.client.sendCommand(["SET", key, value, "PX", String(Math.max(1, Math.ceil(ttl)))]); }
  async delete(input: { namespace?: string; key: string; scope?: PlanetScope }): Promise<boolean> { assertName(input.key, "Key"); return numberResult(await this.client.sendCommand(["DEL", this.key(input.namespace, input.key, input.scope)])) > 0; }
}

export function createRedisProvider(input: { id?: string; client: RedisCommandClient; prefix?: string; schemas?: ProviderSchemaMap }): DataLayerProvider {
  const prefix = (input.prefix ?? "unknownplanet").replace(/:+$/, ""); if (!prefix || /[{}]/.test(prefix)) throw new Error("Redis provider prefix must be non-empty and cannot contain braces.");
  const namespace = (feature: "queue" | "stack" | "keyValue") => {
    const value = (input.schemas?.[feature] ?? prefix).replace(/:+$/, "");
    if (!value || /[{}]/.test(value)) throw new Error(`Redis ${feature} namespace must be non-empty and cannot contain braces.`);
    return value;
  };
  return { id: input.id ?? "redis", queue: new RedisQueueStore(input.client, namespace("queue")), stack: new RedisStackStore(input.client, namespace("stack")), keyValue: new RedisKeyValueStore(input.client, namespace("keyValue")) };
}
