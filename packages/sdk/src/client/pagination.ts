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
