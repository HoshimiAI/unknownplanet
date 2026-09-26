import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createRedisProvider } from "../dist/index.js";

const url = process.env.UP_TEST_REDIS_URL;
if (url) test("Redis persists queue, stack, and expiring key/value operations", async () => {
  const { createClient } = await import("redis");
  const client = createClient({ url });
  const prefix = `up_test_${randomUUID().replaceAll("-", "")}`;
  await client.connect();
  try {
    const provider = createRedisProvider({ client, prefix });
    const scope = { tenantId: `integration-${randomUUID()}`, workspaceId: "workspace-a" };
    const queued = await provider.queue.enqueue({ queue: "live-jobs", value: { task: "roundtrip" }, scope });
    const [claimed] = await provider.queue.claim({ queue: "live-jobs", leaseMs: 5000, scope });
    expect(claimed).toMatchObject({ id: queued.id, value: { task: "roundtrip" }, attempts: 1 });
    expect(await provider.queue.release({ queue: "live-jobs", id: queued.id, leaseToken: claimed.leaseToken, scope })).toBe(true);
    const [retried] = await provider.queue.claim({ queue: "live-jobs", leaseMs: 5000, scope });
    expect(retried).toMatchObject({ id: queued.id, attempts: 2 });
    expect(await provider.queue.ack({ queue: "live-jobs", id: queued.id, leaseToken: retried.leaseToken, scope })).toBe(true);

    await provider.stack.push({ stack: "undo", value: { action: "restore" }, scope });
    expect(await provider.stack.peek({ stack: "undo", scope })).toEqual({ action: "restore" });
    expect(await provider.stack.pop({ stack: "undo", scope })).toEqual({ action: "restore" });
    await provider.keyValue.set({ namespace: "sessions", key: "session-1", value: { userId: "user-1" }, ttlMs: 30_000, scope });
    expect(await provider.keyValue.get({ namespace: "sessions", key: "session-1", scope })).toMatchObject({ value: { userId: "user-1" }, expiresAt: expect.any(Date) });
    expect(await provider.keyValue.delete({ namespace: "sessions", key: "session-1", scope })).toBe(true);
  } finally {
    const keys = await client.sendCommand(["KEYS", `${prefix}:*`]);
    if (Array.isArray(keys) && keys.length) await client.sendCommand(["DEL", ...keys]);
    await client.quit();
  }
});
