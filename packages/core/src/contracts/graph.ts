import type { EdgeId, JsonObject, NodeId, PlanetScope, ScopedInput } from "./common.js";

export interface GraphNode {
  id: NodeId;
  type: string;
  name: string;
  properties: JsonObject;
  embedding?: number[];
  createdAt: Date;
  updatedAt: Date;
}

export interface GraphEdge {
  id: EdgeId;
  sourceId: NodeId;
  targetId: NodeId;
  relation: string;
  properties: JsonObject;
  confidence?: number;
  validFrom?: Date;
  validTo?: Date;
  status?: "candidate" | "canonical" | "disputed" | "rejected" | "deprecated";
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateNodeInput extends ScopedInput {
  id?: NodeId;
  type: string;
  name: string;
  properties?: JsonObject;
  embedding?: number[];
}

export interface UpdateNodeInput extends ScopedInput {
  type?: string;
  name?: string;
  properties?: JsonObject;
  embedding?: number[] | null;
}

export interface CreateEdgeInput extends ScopedInput {
  id?: EdgeId;
  from: NodeId;
  to: NodeId;
  relation: string;
  properties?: JsonObject;
  confidence?: number;
  validFrom?: Date;
  validTo?: Date;
  status?: GraphEdge["status"];
}
export interface UpdateEdgeInput extends ScopedInput { confidence?: number; status?: GraphEdge["status"]; validFrom?: Date | null; validTo?: Date | null; properties?: JsonObject }

export type GraphDirection = "outbound" | "inbound" | "both";
export interface NeighborsInput extends ScopedInput { nodeId: NodeId; direction?: GraphDirection; relation?: string; limit?: number; asOf?: Date }
export interface TraverseInput extends ScopedInput { startIds: NodeId[]; depth: number; direction?: GraphDirection; relation?: string; limit?: number; asOf?: Date }
export interface GraphTraversal { nodes: GraphNode[]; edges: GraphEdge[]; depthByNode: Record<NodeId, number> }
export interface NodeMergeRecord { sourceId: NodeId; targetId: NodeId; mergedAt: Date; source: GraphNode; targetBefore: GraphNode; targetAfter: GraphNode }
export interface GraphTextSearchInput extends ScopedInput { query: string; limit?: number }

export interface GraphStore {
  createNode(input: CreateNodeInput): Promise<GraphNode>;
  getNode(id: NodeId, scope?: PlanetScope): Promise<GraphNode | null>;
  updateNode(id: NodeId, input: UpdateNodeInput): Promise<GraphNode | null>;
  /** Deletes the node and, by contract, all incident edges and their evidence. */
  deleteNode(id: NodeId, scope?: PlanetScope): Promise<boolean>;
  /** Atomically redirects incident edges/evidence, removes the duplicate, and records an audit entry. */
  mergeNodes?(input: ScopedInput & { sourceId: NodeId; targetId: NodeId }): Promise<NodeMergeRecord>;
  listMerges?(input: ScopedInput & { nodeId?: NodeId; limit?: number }): Promise<NodeMergeRecord[]>;
  listMergesPage?(input: ScopedInput & { nodeId?: NodeId; limit?: number; afterSourceId?: string }): Promise<{ items: NodeMergeRecord[]; hasMore: boolean }>;
  createEdge(input: CreateEdgeInput): Promise<GraphEdge>;
  getEdge(id: EdgeId, scope?: PlanetScope): Promise<GraphEdge | null>;
  updateEdge(id: EdgeId, input: UpdateEdgeInput): Promise<GraphEdge | null>;
  deleteEdge(id: EdgeId, scope?: PlanetScope): Promise<boolean>;
  neighbors(input: NeighborsInput): Promise<GraphEdge[]>;
  traverse(input: TraverseInput): Promise<GraphTraversal>;
  searchNodes(input: GraphTextSearchInput): Promise<GraphNode[]>;
}
