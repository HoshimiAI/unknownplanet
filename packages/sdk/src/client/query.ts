import type { DocumentChunkStore, EmbeddingProvider, EvidenceStore, GraphNode, GraphStore, MemoryRecord, MemorySearchInput, PlanetScope, ProviderOperation, VectorStore } from "@unknown-planet/core";
import { PlanetCapabilityError, PlanetValidationError } from "../errors.js";
import type { GraphSearchInput, GraphSearchResult, PlanetQueryInput, PlanetQueryResult, PlanetQueryRanker } from "../types.js";

export interface QueryContext {
  scope: PlanetScope;
  embeddingProvider?: EmbeddingProvider;
  queryRanker?: PlanetQueryRanker;
  searchGraph(input: GraphSearchInput): Promise<GraphSearchResult[]>;
  searchMemories(input: MemorySearchInput): Promise<MemoryRecord[]>;
  resolveGraph(operation: ProviderOperation): GraphStore | undefined;
  resolveEvidence(operation: ProviderOperation): EvidenceStore | undefined;
  resolveChunks(operation: ProviderOperation): DocumentChunkStore | undefined;
  resolveVector(operation: ProviderOperation): VectorStore | undefined;
  requireChunks(operation: ProviderOperation): DocumentChunkStore;
  requireVector(operation: ProviderOperation): VectorStore;
  requireGraph(operation: ProviderOperation): GraphStore;
  embed(text: string, collection?: string): Promise<number[]>;
}

export async function queryKnowledge(input: PlanetQueryInput, context: QueryContext): Promise<PlanetQueryResult[]> {
  if (!input.text.trim()) throw new PlanetValidationError("Query text cannot be empty.");
  const limit = Math.max(1, Math.min(input.limit ?? 20, 100000));
  const search = input.search ?? { keyword: true, vector: true, graph: true };
  const hasGraph = Boolean(context.resolveGraph("search"));
  const hasChunks = Boolean(context.resolveChunks("search"));
  if (!hasGraph && !hasChunks) throw new PlanetCapabilityError("GraphStore or DocumentChunkStore for knowledge query");
  const keywordPromise = search.keyword && hasGraph ? context.searchGraph({ query: input.text, limit: limit * 3, asOf: input.asOf, includeContext: Boolean(context.queryRanker) }) : Promise.resolve([]);
  const vectorPromise = search.vector && hasGraph && context.embeddingProvider && context.resolveVector("search") ? context.searchGraph({ query: input.text, semantic: true, limit: limit * 3, graph: { depth: search.graph ? input.expand?.relationDepth ?? 1 : 0 }, asOf: input.asOf }) : Promise.resolve([]);
  const chunkKeywordPromise = search.keyword && hasChunks ? context.requireChunks("search").search({ query: input.text, limit: limit * 3, scope: context.scope }) : Promise.resolve([]);
  const chunkVectorPromise = search.vector && hasChunks && context.embeddingProvider && context.resolveVector("search") ? (async () => {
    const embedding = await context.embed(input.text, "document-chunk");
    const matches = await context.requireVector("search").search({ embedding, namespace: "document-chunk", model: context.embeddingProvider!.model, limit: limit * 3, scope: context.scope });
    const records = [];
    for (const match of matches) { const chunk = await context.requireChunks("read").get(match.id, context.scope); if (chunk && (!input.filters?.documentId || chunk.documentId === input.filters.documentId)) records.push({ chunk, score: match.score }); }
    return records;
  })() : Promise.resolve([]);
  const [keyword, vector, chunkKeywords, chunkVectors] = await Promise.all([keywordPromise, vectorPromise, chunkKeywordPromise, chunkVectorPromise]);
  let graphResults: GraphSearchResult[] = [];
  if (search.graph && !search.vector && keyword.length) {
    const traversal = await context.requireGraph("search").traverse({ startIds: keyword.map((item) => item.node.id), depth: input.expand?.relationDepth ?? 1, limit: limit * 10, scope: context.scope, asOf: input.asOf });
    const evidence = traversal.edges.length ? await context.resolveEvidence("read")?.list({ edgeIds: traversal.edges.map((edge) => edge.id), limit: limit * 20, scope: context.scope }) ?? [] : [];
    graphResults = traversal.nodes.map((node) => {
      const edges = traversal.edges.filter((edge) => edge.sourceId === node.id || edge.targetId === node.id);
      return { node, score: 0.75 ** (traversal.depthByNode[node.id] ?? 0), edges, evidence: evidence.filter((item) => edges.some((edge) => edge.id === item.edgeId)) };
    });
  }
  const fused = new Map<string, PlanetQueryResult>();
  const add = (item: GraphSearchResult, weight: number) => {
    const match = input.filters?.nodeType && item.node.type !== input.filters.nodeType ? false : true;
    const meta = item.node.properties;
    if (!match || (input.filters?.documentId && meta.documentId !== input.filters.documentId) || (input.filters?.metadata && !Object.entries(input.filters.metadata).every(([key, value]) => meta[key] === value))) return;
    const prior = fused.get(item.node.id);
    if (prior) { prior.score = Math.min(1, prior.score + item.score * weight); prior.edges = [...new Map([...prior.edges, ...item.edges].map((edge) => [edge.id, edge])).values()]; prior.evidence = [...new Map([...prior.evidence, ...item.evidence].map((evidence) => [evidence.id, evidence])).values()]; prior.sources = [...prior.sources, ...item.evidence.map((evidence) => ({ type: evidence.sourceType, id: evidence.sourceId, documentId: evidence.documentId, chunkId: evidence.chunkId })), ...((item as PlanetQueryResult).sources ?? [])].filter((source, index, all) => all.findIndex((other) => other.id === source.id && other.documentId === source.documentId && other.chunkId === source.chunkId) === index); }
    else fused.set(item.node.id, { ...item, score: item.score * weight, sources: item.evidence.map((evidence) => ({ type: evidence.sourceType, id: evidence.sourceId, documentId: evidence.documentId, chunkId: evidence.chunkId })) });
  };
  for (const item of keyword) add(item, 0.5);
  for (const item of vector) add(item, 1);
  for (const item of graphResults) add(item, 0.5);
  for (const chunk of chunkKeywords) {
    const node: GraphNode = { id: chunk.id, type: "document_chunk", name: chunk.text ?? "", properties: { ...chunk.metadata, documentId: chunk.documentId, chunkId: chunk.id }, createdAt: chunk.createdAt, updatedAt: chunk.updatedAt };
    add({ node, score: 0.5, evidence: [], edges: [] }, 0.5);
    const result = fused.get(node.id); if (result) result.sources = [{ type: "document", documentId: chunk.documentId, chunkId: chunk.id }];
  }
  for (const { chunk, score } of chunkVectors) {
    const node: GraphNode = { id: chunk.id, type: "document_chunk", name: chunk.text ?? "", properties: { ...chunk.metadata, documentId: chunk.documentId, chunkId: chunk.id }, createdAt: chunk.createdAt, updatedAt: chunk.updatedAt };
    add({ node, score, evidence: [], edges: [] }, 1);
    const result = fused.get(node.id); if (result && !result.sources.length) result.sources = [{ type: "document", documentId: chunk.documentId, chunkId: chunk.id }];
  }
  let results = [...fused.values()].sort((a, b) => b.score - a.score || a.node.name.localeCompare(b.node.name) || a.node.id.localeCompare(b.node.id));
  if (input.filters?.agentId) {
    const allowed = new Set((await context.searchMemories({ agentId: input.filters.agentId, query: input.text, limit: limit * 3 })).map((memory) => memory.id));
    results = results.filter((result) => result.node.type !== "memory" || allowed.has(result.node.id));
  }
  if (context.queryRanker) results = await context.queryRanker({ query: input.text, results });
  results = results.slice(0, limit);
  if (input.includeEvidence !== false && hasGraph) {
    const missing = results.filter((result) => result.node.type !== "document_chunk" && result.edges.length === 0);
    const graph = context.requireGraph("read");
    const edgeLists = await Promise.all(missing.map((result) => graph.neighbors({ nodeId: result.node.id, direction: "both", limit: 1000, scope: context.scope, asOf: input.asOf })));
    const edgeIds = [...new Set(edgeLists.flat().map((edge) => edge.id))];
    const evidence = edgeIds.length ? await context.resolveEvidence("read")?.list({ edgeIds, limit: Math.max(limit * 20, edgeIds.length), scope: context.scope }) ?? [] : [];
    missing.forEach((result, index) => {
      result.edges = edgeLists[index]!;
      result.evidence = evidence.filter((item) => result.edges.some((edge) => edge.id === item.edgeId));
      result.sources = [...new Map([...result.sources, ...result.evidence.map((item) => ({ type: item.sourceType, id: item.sourceId, documentId: item.documentId, chunkId: item.chunkId }))].map((source) => [JSON.stringify(source), source])).values()];
    });
  }
  if (input.includeEvidence === false) for (const result of results) result.evidence = [];
  return results;
}
