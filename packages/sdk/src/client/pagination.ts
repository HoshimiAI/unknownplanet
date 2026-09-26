import { PlanetValidationError } from "../errors.js";
import { decodeBase64, encodeBase64 } from "./encoding.js";

export function encodeCursor(id: string): string { return `v1.${encodeBase64(new TextEncoder().encode(id))}`; }

export function decodeCursor(cursor?: string): string | undefined {
  if (!cursor) return undefined;
  try {
    if (!cursor.startsWith("v1.")) throw new Error();
    return new TextDecoder("utf-8", { fatal: true }).decode(decodeBase64(cursor.slice(3)));
  } catch {
    throw new PlanetValidationError("Pagination cursor is invalid or uses an unsupported version.");
  }
}

export function pageById<T>(records: T[], cursor: string | undefined, limit: number, getId: (record: T) => string) {
  const after = decodeCursor(cursor);
  const ordered = records.slice().sort((a, b) => getId(a) < getId(b) ? -1 : getId(a) > getId(b) ? 1 : 0).filter((record) => !after || getId(record) > after);
  const items = ordered.slice(0, limit);
  return { items, nextCursor: ordered.length > limit && items.length ? encodeCursor(getId(items[items.length - 1]!)) : undefined };
}

/** Pages an already ranked result window without changing its order. */
export function pageInResultOrder<T>(records: T[], cursor: string | undefined, limit: number, getId: (record: T) => string) {
  const ids = records.map(getId);
  let hash = 2166136261;
  for (const id of ids) for (const character of `${id.length}:${id};`) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
  const fingerprint = `${ids.length}:${hash.toString(16)}`;
  let after: string | undefined;
  if (cursor?.startsWith("v2.")) {
    try {
      const payload: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decodeBase64(cursor.slice(3))));
      if (!Array.isArray(payload) || payload.length !== 2 || typeof payload[0] !== "string" || payload[1] !== fingerprint) throw new Error("changed");
      after = payload[0];
    } catch { throw new PlanetValidationError("Search results changed; restart pagination from the first page."); }
  } else after = decodeCursor(cursor);
  const index = after === undefined ? 0 : records.findIndex((record) => getId(record) === after) + 1;
  if (index === 0 && after !== undefined) throw new PlanetValidationError("Pagination cursor is no longer in the result window.");
  const items = records.slice(index, index + limit);
  const last = items.at(-1);
  const nextCursor = index + limit < records.length && last ? `v2.${encodeBase64(new TextEncoder().encode(JSON.stringify([getId(last), fingerprint])))}` : undefined;
  return { items, nextCursor };
}
