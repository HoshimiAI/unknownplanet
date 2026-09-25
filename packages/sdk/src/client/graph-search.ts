import type { EmbeddingProvider, Evidence, EvidenceStore, GraphStore, GraphTraversal, PlanetScope, ProviderOperation, VectorSearchResult, VectorStore } from "@unknown-planet/core";
import type { GraphSearchInput, GraphSearchResult, RetrievalConfig } from "../types.js";

export interface GraphSearchContext {
  scope: PlanetScope;
  embeddingProvider?: EmbeddingProvider;
  retrieval: RetrievalConfig;
  requireGraph(operation: ProviderOperation): GraphStore;
  requireVector(operation: ProviderOperation): VectorStore;
  resolveEvidence(operation: ProviderOperation): EvidenceStore | undefined;
  embed(text: string, collection?: string): Promise<number[]>;
}

export async function searchGraph(input: GraphSearchInput, context: GraphSearchContext): Promise<GraphSearchResult[]> {
  const limit = input.limit ?? 20;
  if (!input.semantic) {
    const nodes = await context.requireGraph("search").searchNodes({ query: input.query, limit, scope: context.scope });
    return nodes.map((item) => ({ node: item, score: 1, evidence: [], edges: [] }));
  }
  const embedding = await context.embed(input.query, input.vectorNamespace ?? context.retrieval.nodeNamespace ?? "node");
  const candidates = await context.requireVector("search").search({
    embedding,
    namespace: input.vectorNamespace ?? context.retrieval.nodeNamespace ?? "node",
    model: context.embeddingProvider?.model,
    limit: input.candidateLimit ?? context.retrieval.candidateLimit ?? Math.max(limit, limit * 2),
    scope: context.scope,
  });
  return expandAndRank(context, candidates, input.graph?.depth ?? context.retrieval.defaultGraphDepth ?? 0, limit, input.query, input.asOf);
}

async function expandAndRank(context: GraphSearchContext, candidates: VectorSearchResult[], depth: number, limit: number, query: string, asOf?: Date): Promise<GraphSearchResult[]> {
  if (candidates.length === 0) return [];
  const candidateScores = new Map(candidates.map((candidate) => [candidate.id, candidate.score]));
  const traversal: GraphTraversal = await context.requireGraph("search").traverse({ startIds: candidates.map((candidate) => candidate.id), depth, limit: limit * 10, scope: context.scope, asOf });
  const evidenceStore = context.resolveEvidence("read");
  const evidence = evidenceStore && traversal.edges.length > 0
    ? await evidenceStore.list({ edgeIds: traversal.edges.map((item) => item.id), limit: limit * 20, scope: context.scope }) : [];
  const evidenceByEdge = new Map<string, Evidence[]>();
  for (const item of evidence) evidenceByEdge.set(item.edgeId, [...(evidenceByEdge.get(item.edgeId) ?? []), item]);
  const results = traversal.nodes.map((item) => {
    const nodeDepth = traversal.depthByNode[item.id] ?? 0;
    const direct = candidateScores.get(item.id) ?? 0;
    const score = direct > 0 ? direct : Math.max(...candidates.map((candidate) => candidate.score * Math.pow(context.retrieval.graphDecay ?? 0.8, nodeDepth)));
    const edges = traversal.edges.filter((edge) => edge.sourceId === item.id || edge.targetId === item.id);
    return { node: item, score, edges, evidence: edges.flatMap((edge) => evidenceByEdge.get(edge.id) ?? []) };
  }).sort((left, right) => right.score - left.score || left.node.name.localeCompare(right.node.name) || left.node.id.localeCompare(right.node.id));
  const ranked = context.retrieval.ranker ? await context.retrieval.ranker({ query, results }) : results;
  return ranked.slice(0, limit);
}
