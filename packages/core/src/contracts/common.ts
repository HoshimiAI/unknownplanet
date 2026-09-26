export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject { [key: string]: JsonValue }

/** JSON Schema vocabulary accepted for developer-defined custom data. */
export type PlanetJsonSchema = boolean | {
  type?: "null" | "boolean" | "object" | "array" | "number" | "integer" | "string" | Array<"null" | "boolean" | "object" | "array" | "number" | "integer" | "string">;
  properties?: Record<string, PlanetJsonSchema>;
  required?: string[];
  additionalProperties?: boolean | PlanetJsonSchema;
  items?: PlanetJsonSchema;
  enum?: JsonValue[];
  const?: JsonValue;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
};

export type NodeId = string;
export type EdgeId = string;
export type DocumentId = string;
export type EvidenceId = string;
export type IdentityId = string;

/** The isolation boundary for every Planet record. Applications normally create one scoped client per request. */
export interface PlanetScope { tenantId: string; workspaceId?: string }
export interface ScopedInput { scope?: PlanetScope }

/** Unambiguous, versioned storage key for a tenant and optional workspace. */
export function scopeStorageKey(scope?: PlanetScope): string {
  const tenantId = scope?.tenantId ?? "default";
  if (!tenantId.trim()) throw new Error("Planet scope requires a non-empty tenantId.");
  const hex = (value: string) => Array.from(new TextEncoder().encode(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `v2:${hex(tenantId)}:${scope?.workspaceId ? hex(scope.workspaceId) : "-"}`;
}
