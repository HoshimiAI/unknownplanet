export async function stableUuid(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function canonicalEntityName(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase().replace(/\b(incorporated|inc|corporation|corp|limited|ltd|llc|company|co)\b\.?/g, "").replace(/[^a-z0-9]/g, "");
}

export function entityNameSimilarity(left: string, right: string): number {
  const a = canonicalEntityName(left), b = canonicalEntityName(right);
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0]!; previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const old = previous[j]!;
      previous[j] = Math.min(previous[j]! + 1, previous[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = old;
    }
  }
  return 1 - previous[b.length]! / Math.max(a.length, b.length);
}
