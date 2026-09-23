import type { DocumentChunkStore, EmbeddingProvider, GraphNode, GraphStore, MemoryRecord, MemorySearchInput, PlanetScope, ProviderOperation, VectorStore } from "@unknown-planet/core";
import { PlanetValidationError } from "../errors.js";
import type { GraphSearchInput, GraphSearchResult, PlanetQueryInput, PlanetQueryResult, PlanetQueryRanker } from "../types.js";

export interface QueryContext {
  scope: PlanetScope;
  embeddingProvider?: EmbeddingProvider;
  queryRanker?: PlanetQueryRanker;
  searchGraph(input: GraphSearchInput): Promise<GraphSearchResult[]>;
  searchMemories(input: MemorySearchInput): Promise<MemoryRecord[]>;
  resolveChunks(operation: ProviderOperation): DocumentChunkStore | undefined;
  resolveVector(operation: ProviderOperation): VectorStore | undefined;
  requireChunks(operation: ProviderOperation): DocumentChunkStore;
  requireVector(operation: ProviderOperation): VectorStore;
  requireGraph(operation: ProviderOperation): GraphStore;
  embed(text: string): Promise<number[]>;
}

export async function queryKnowledge(input: PlanetQueryInput, context: QueryContext): Promise<PlanetQueryResult[]> {
  if (!input.text.trim()) throw new PlanetValidationError("Query text cannot be empty.");
  const limit = Math.max(1, Math.min(input.limit ?? 20, 100000));
  const search = input.search ?? { keyword: true, vector: true, graph: true };
  const keywordPromise = search.keyword ? context.searchGraph({ query: input.text, limit: limit * 3 }) : Promise.resolve([]);
  const vectorPromise = search.vector ? context.searchGraph({ query: input.text, semantic: true, limit: limit * 3, graph: { depth: search.graph ? input.expand?.relationDepth ?? 1 : 0 }, asOf: input.asOf }) : Promise.resolve([]);
  const chunkKeywordPromise = search.keyword && context.resolveChunks("search") ? context.requireChunks("search").search({ query: input.text, limit: limit * 3, scope: context.scope }) : Promise.resolve([]);
  const chunkVectorPromise = search.vector && context.embeddingProvider && context.resolveVector("search") ? (async () => {
    const embedding = await context.embed(input.text);
    const matches = await context.requireVector("search").search({ embedding, namespace: "document-chunk", model: context.embeddingProvider!.model, limit: limit * 3, scope: context.scope });
    const records = [];
    for (const match of matches) { const chunk = await context.requireChunks("read").get(match.id, context.scope); if (chunk && (!input.filters?.documentId || chunk.documentId === input.filters.documentId)) records.push({ chunk, score: match.score }); }
    return records;
  })() : Promise.resolve([]);
  const [keyword, vector, chunkKeywords, chunkVectors] = await Promise.all([keywordPromise, vectorPromise, chunkKeywordPromise, chunkVectorPromise]);
  let graphResults: GraphSearchResult[] = [];
  if (search.graph && !search.vector && keyword.length) {
    const traversal = await context.requireGraph("search").traverse({ startIds: keyword.map((item) => item.node.id), depth: input.expand?.relationDepth ?? 1, limit: limit * 10, scope: context.scope, asOf: input.asOf });
    graphResults = traversal.nodes.map((node) => ({ node, score: 0.75 ** (traversal.depthByNode[node.id] ?? 0), edges: traversal.edges.filter((edge) => edge.sourceId === node.id || edge.targetId === node.id), evidence: [] }));
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
    const node: GraphNode = { id: chunk.id, type: "document_chunk", name: chunk.text ?? "", properties: { documentId: chunk.documentId, chunkId: chunk.id, ...chunk.metadata }, createdAt: chunk.createdAt, updatedAt: chunk.updatedAt };
    add({ node, score: 0.5, evidence: [], edges: [] }, 0.5);
    const result = fused.get(node.id); if (result) result.sources = [{ type: "document", documentId: chunk.documentId, chunkId: chunk.id }];
  }
  for (const { chunk, score } of chunkVectors) {
    const node: GraphNode = { id: chunk.id, type: "document_chunk", name: chunk.text ?? "", properties: { documentId: chunk.documentId, chunkId: chunk.id, ...chunk.metadata }, createdAt: chunk.createdAt, updatedAt: chunk.updatedAt };
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
  if (input.includeEvidence === false) for (const result of results) result.evidence = [];
  return results;
}
