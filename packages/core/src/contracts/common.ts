export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject { [key: string]: JsonValue }

export type NodeId = string;
export type EdgeId = string;
export type DocumentId = string;
export type EvidenceId = string;
export type IdentityId = string;

/** The isolation boundary for every Planet record. Applications normally create one scoped client per request. */
export interface PlanetScope { tenantId: string; workspaceId?: string }
export interface ScopedInput { scope?: PlanetScope }
