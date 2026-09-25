import type { AddMemoryInput, GraphEdge, IngestionCheckpoint, MemoryRecord } from "@unknown-planet/core";
import { PlanetProviderError, PlanetValidationError } from "../../errors.js";
import { stableUuid } from "../identity.js";
import type { KnowledgeIngestionContext } from "./context.js";

export async function addMemoryCore(input: AddMemoryInput, context: KnowledgeIngestionContext, checkpoint?: (value: IngestionCheckpoint) => Promise<void>): Promise<MemoryRecord> {
  if (!input.agentId.trim() || !input.content.trim()) throw new PlanetValidationError("Memory requires a non-empty agentId and content.");
  for (const [key, value] of [["importance", input.importance], ["confidence", input.confidence]] as const) if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 1)) throw new PlanetValidationError(`Memory ${key} must be between 0 and 1.`);
  const id = input.id ?? (input.source ? await stableUuid(`memory:${context.scope.tenantId}:${context.scope.workspaceId ?? ""}:${input.source.type}:${input.source.id}`) : crypto.randomUUID());
  const [embedding, entities] = await Promise.all([
    context.embed(input.content, ["memory", context.retrieval.nodeNamespace ?? "node"]),
    context.extractEntities(input.content),
  ]);
  const record = await context.requireMemories("write").add({ ...input, id, content: input.content.trim(), scope: context.scope });
  await checkpoint?.("memory_saved");
  await context.requireVector("write").upsert({ id, namespace: "memory", embedding, model: context.embeddingProvider?.model, metadata: { agentId: record.agentId, userId: record.userId ?? "", sessionId: record.sessionId ?? "", type: record.type }, scope: context.scope });
  await context.requireVector("write").upsert({ id, namespace: context.retrieval.nodeNamespace ?? "node", embedding, model: context.embeddingProvider?.model, metadata: { type: "memory", agentId: record.agentId }, scope: context.scope });
  await checkpoint?.("vectors_saved");
  const graph = context.requireGraph("write");
  let memoryNode = await graph.getNode(id, context.scope);
  if (!memoryNode) memoryNode = await context.createGraphNode({ id, type: "memory", name: record.content.slice(0, 120), properties: { agentId: record.agentId, memoryType: record.type, source: record.source ? { type: record.source.type, id: record.source.id } : null }, embedding });
  else await graph.updateNode(id, { type: "memory", name: record.content.slice(0, 120), properties: { agentId: record.agentId, memoryType: record.type, source: record.source ? { type: record.source.type, id: record.source.id } : null }, embedding, scope: context.scope });
  const desiredEntityIds = new Set<string>();
  for (const entity of entities) {
    const identity = await context.resolveEntityIdentity(entity);
    const entityId = identity?.id ?? await stableUuid(`entity:${context.scope.tenantId}:${context.scope.workspaceId ?? ""}:${entity.type}:${entity.name.normalize("NFKC").toLocaleLowerCase()}`);
    desiredEntityIds.add(entityId);
    let entityNode = await graph.getNode(entityId, context.scope);
    if (!entityNode) {
      const matches = await graph.searchNodes({ query: entity.name, limit: 20, scope: context.scope });
      entityNode = matches.find((candidate) => candidate.type === entity.type && candidate.name.normalize("NFKC").toLocaleLowerCase() === entity.name.normalize("NFKC").toLocaleLowerCase()) ?? null;
      if (!entityNode) entityNode = await context.createGraphNode({ id: entityId, type: entity.type, name: entity.name, properties: { aliases: entity.aliases } });
    }
    const currentEdges = await graph.neighbors({ nodeId: memoryNode.id, direction: "outbound", relation: "MENTIONS", limit: 1000, scope: context.scope });
    let edge: GraphEdge | null | undefined = currentEdges.find((item) => item.targetId === entityNode.id);
    if (!edge) {
      const edgeId = await stableUuid(`memory-entity:${id}:${entityNode.id}`);
      try { edge = await graph.createEdge({ id: edgeId, from: memoryNode.id, to: entityNode.id, relation: "MENTIONS", confidence: record.confidence ?? 1, properties: { sourceId: id }, scope: context.scope }); }
      catch (cause) { edge = await graph.getEdge(edgeId, context.scope); if (!edge) throw new PlanetProviderError(`memory graph linking for '${entity.name}'`, cause); }
    }
    const evidenceId = await stableUuid(`memory-evidence:${id}:${edge.id}`);
    if (context.resolveEvidence("write")) {
      const prior = await context.resolveEvidence("read")!.list({ edgeId: edge.id, sourceId: id, scope: context.scope, limit: 1 });
      if (!prior.length) {
        try { await context.requireEvidence("write").add({ id: evidenceId, edgeId: edge.id, sourceId: id, sourceType: record.source?.type ?? "memory", extractor: context.entityExtractor ? "entity-extractor" : "memory-ingestion", confidence: record.confidence, metadata: { entity: entity.name }, scope: context.scope }); }
        catch (cause) { if (!(await context.requireEvidence("read").list({ edgeId: edge.id, sourceId: id, scope: context.scope, limit: 1 })).length) throw new PlanetProviderError(`memory evidence attachment for '${id}'`, cause); }
      }
    }
  }
  if (context.entityExtractor) {
    const current = await graph.neighbors({ nodeId: memoryNode.id, direction: "outbound", relation: "MENTIONS", limit: 1000, scope: context.scope });
    for (const stale of current) if (!desiredEntityIds.has(stale.targetId)) await graph.deleteEdge(stale.id, context.scope);
  }
  await checkpoint?.("knowledge_saved");
  return record;
}
