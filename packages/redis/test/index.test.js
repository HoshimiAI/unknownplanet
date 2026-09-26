import { expect, test } from "bun:test";
import { createRedisProvider } from "../dist/index.js";

test("Redis provider scopes and encodes queue, stack, and key/value commands", async () => {
  const commands = [];
  const client = { sendCommand: async (args) => {
    commands.push(args);
    if (args[0] === "EVAL" && args[1].includes("local id = string.format")) return "00000000000000000001";
    if (args[0] === "EVAL" && args[1].includes("local expired")) return ["job-1", JSON.stringify({ value: { task: "index" }, attempts: 1, availableAt: 1000, leaseToken: "lease-1", leaseUntil: 2000 })];
    if (args[0] === "EVAL" && args[1].includes("local untilTime")) return "1";
    if (args[0] === "LPUSH") return "1";
    if (args[0] === "LPOP") return JSON.stringify({ undo: true });
    if (args[0] === "LINDEX") return JSON.stringify({ undo: true });
    if (args[0] === "LLEN") return "1";
    if (args[0] === "SET") return "OK";
    if (args[0] === "GET") return JSON.stringify({ value: { userId: "u1" }, expiresAt: "2030-01-01T00:00:00.000Z" });
    if (args[0] === "DEL") return "1";
    throw new Error(`Unexpected Redis command: ${args[0]}`);
  } };
  const provider = createRedisProvider({ client, prefix: "test:" });
  const scope = { tenantId: "acme team", workspaceId: "research/1" };

  const queued = await provider.queue.enqueue({ queue: "doc jobs", value: { task: "index" }, scope });
  expect(queued).toMatchObject({ id: "00000000000000000001", queue: "doc jobs", attempts: 0, value: { task: "index" } });
  expect(commands[0][3]).toContain("tacme%20team%wresearch%2F1%qdoc%20jobs");
  expect(await provider.queue.claim({ queue: "doc jobs", scope })).toMatchObject([{ id: "job-1", attempts: 1, value: { task: "index" } }]);
  expect(await provider.queue.ack({ queue: "doc jobs", id: "job-1", leaseToken: "lease-1", scope })).toBe(true);
  expect(await provider.queue.release({ queue: "doc jobs", id: "job-1", leaseToken: "lease-1", delayMs: 250, scope })).toBe(true);
  await provider.stack.push({ stack: "undo", value: { undo: true }, scope });
  expect(await provider.stack.peek({ stack: "undo", scope })).toEqual({ undo: true });
  expect(await provider.stack.pop({ stack: "undo", scope })).toEqual({ undo: true });
  expect(await provider.stack.size({ stack: "undo", scope })).toBe(1);
  await provider.keyValue.set({ namespace: "sessions", key: "session-1", value: { userId: "u1" }, ttlMs: 5000, scope });
  expect(await provider.keyValue.get({ namespace: "sessions", key: "session-1", scope })).toMatchObject({ value: { userId: "u1" }, expiresAt: expect.any(Date) });
  expect(commands.find((command) => command[0] === "SET").slice(-2)).toEqual(["PX", "5000"]);
  expect(await provider.keyValue.delete({ namespace: "sessions", key: "session-1", scope })).toBe(true);
  await provider.keyValue.set({ key: "expired", value: "now gone", ttlMs: 0, scope });
  expect(commands.at(-1)[0]).toBe("DEL");
  expect(commands.at(-1)[1]).toContain(":expired");
});

test("Redis provider validates names, delays, TTLs, and key prefixes", async () => {
  const provider = createRedisProvider({ client: { sendCommand: async () => "0" } });
  await expect(provider.queue.enqueue({ queue: " ", value: null })).rejects.toThrow("Queue name cannot be empty");
  await expect(provider.queue.enqueue({ queue: "jobs", value: null, delayMs: -1 })).rejects.toThrow("non-negative");
  await expect(provider.keyValue.set({ key: "key", value: "value", ttlMs: -1 })).rejects.toThrow("non-negative");
  expect(() => createRedisProvider({ client: { sendCommand: async () => "0" }, prefix: "bad{prefix}" })).toThrow("cannot contain braces");
});

test("Redis schemas map supplies independent key prefixes per capability", async () => {
  const commands = [];
  const provider = createRedisProvider({ client: { sendCommand: async (args) => { commands.push(args); return "OK"; } }, schemas: { keyValue: "sessions_v2", stack: "undo_v2" } });
  await provider.keyValue.set({ key: "token", value: "x" });
  await provider.stack.push({ stack: "history", value: null });
  expect(commands[0][1]).toContain("sessions_v2:kv:");
  expect(commands[1][1]).toContain("undo_v2:stack:");
  expect(() => createRedisProvider({ client: { sendCommand: async () => "" }, schemas: { queue: "bad{namespace}" } })).toThrow("cannot contain braces");
});
