import type { IngestionCheckpoint, JsonObject } from "@unknown-planet/core";
import { PlanetProviderError, PlanetValidationError } from "../../errors.js";
import { withSpan } from "../../observability/telemetry.js";
import { stableUuid } from "../identity.js";
import type { DocumentIngestInput, DocumentIngestResult } from "../../types.js";
import type { KnowledgeIngestionContext } from "./context.js";

export async function ingestDocumentCore(input: DocumentIngestInput, context: KnowledgeIngestionContext, checkpoint?: (value: IngestionCheckpoint, documentId?: string) => Promise<void>): Promise<DocumentIngestResult> {
  const contentType = input.contentType.split(";")[0]!.trim().toLowerCase();
  const text = await withSpan("planet.ingestion.parse", { "unknownplanet.document.content_type": contentType }, async () => {
    const parse = context.documentParsers[contentType];
    let parsedText: string;
    if (parse) parsedText = await context.parse(parse, input.data, contentType);
    else if (contentType === "text/plain" || contentType === "text/markdown" || contentType === "text/x-markdown") parsedText = new TextDecoder("utf-8", { fatal: true }).decode(input.data);
    else if (contentType === "text/html") parsedText = new TextDecoder("utf-8", { fatal: true }).decode(input.data).replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/[ \t\r\n]+/g, " ").trim();
    else if (contentType === "application/json") { const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.data)); parsedText = JSON.stringify(parsed, null, 2); }
    else if (contentType === "application/pdf") throw new PlanetValidationError("PDF ingestion requires a configured DocumentParser for application/pdf.");
    else throw new PlanetValidationError(`Unsupported document content type '${contentType}'.`);
    if (!parsedText.trim()) throw new PlanetValidationError("Document has no extractable text.");
    return parsedText;
  });
  await checkpoint?.("parsed");
  const size = input.chunkSize ?? 1200; const overlap = input.overlap ?? 150;
  if (!Number.isInteger(size) || size < 64 || !Number.isInteger(overlap) || overlap < 0 || overlap >= size) throw new PlanetValidationError("Chunk size must be at least 64 and overlap must be between zero and chunk size.");
  const id = await stableUuid(`document:${context.scope.tenantId}:${context.scope.workspaceId ?? ""}:${input.externalId ?? input.contentUri ?? `${contentType}:${text}`}`);
  const document = await context.requireDocuments("write").create({ id, externalId: input.externalId, title: input.title, contentUri: input.contentUri ?? `unknownplanet://document/${id}`, metadata: (input.metadata ?? {}) as JsonObject, scope: context.scope });
  await checkpoint?.("document_saved", id);
  const previousChunks = await context.requireChunks("read").list({ documentId: id, limit: 100000, scope: context.scope });
  const ranges: Array<{ start: number; end: number }> = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + size);
    if (end < text.length) { const boundary = text.lastIndexOf(" ", end); if (boundary > start + Math.floor(size * 0.6)) end = boundary; }
    ranges.push({ start, end }); if (end === text.length) break; start = Math.max(start + 1, end - overlap);
  }
  const chunks = await withSpan("planet.ingestion.chunk", {}, async () => {
    const created = [];
    for (let index = 0; index < ranges.length; index += 1) {
      const range = ranges[index]!; const raw = text.slice(range.start, range.end); const body = raw.trim();
      const sourceStart = range.start + raw.length - raw.trimStart().length; const sourceEnd = sourceStart + body.length;
      const chunkId = await stableUuid(`chunk:${id}:${index}:${body}`);
      const chunk = await context.requireChunks("write").create({ id: chunkId, documentId: id, text: body, startOffset: sourceStart, endOffset: sourceEnd, metadata: { index, contentType }, scope: context.scope });
      created.push(chunk);
    }
    return created;
  });
  await checkpoint?.("chunks_saved");
  await withSpan("planet.ingestion.embed_and_index", { "unknownplanet.chunk.count": chunks.length }, async () => {
    if (context.embeddingProvider && chunks.length > 0) {
      const vectors = await context.embedMany(chunks.map((chunk) => chunk.text ?? ""), "document-chunk");
      for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index]!;
      const embedding = vectors[index]!;
      await context.requireVector("write").upsert({ id: chunk.id, namespace: "document-chunk", model: context.embeddingProvider.model, embedding, metadata: { documentId: id, index }, scope: context.scope });
      }
    }
  });
  await checkpoint?.("vectors_saved");
  const keptChunkIds = new Set(chunks.map((chunk) => chunk.id));
  for (const previous of previousChunks) if (!keptChunkIds.has(previous.id) && context.resolveVector("write")) await context.requireVector("write").delete({ id: previous.id, namespace: "document-chunk", scope: context.scope });
  await context.requireChunks("write").deleteExcept({ documentId: id, keepIds: [...keptChunkIds], scope: context.scope });
  await withSpan("planet.ingestion.knowledge", {}, async () => { if (context.entityExtractor) {
    const entities = await context.extractEntities(text); const graph = context.requireGraph("write");
    let sourceNode = await graph.getNode(id, context.scope);
    if (!sourceNode) sourceNode = await context.createGraphNode({ id, type: "document", name: input.title, properties: { documentId: id } });
    else await graph.updateNode(id, { type: "document", name: input.title, properties: { documentId: id }, scope: context.scope });
    const desiredIds = new Set<string>();
    for (const entity of entities) {
      const identity = await context.resolveEntityIdentity(entity);
      const entityId = identity?.id ?? await stableUuid(`entity:${context.scope.tenantId}:${context.scope.workspaceId ?? ""}:${entity.type}:${entity.name.normalize("NFKC").toLocaleLowerCase()}`);
      desiredIds.add(entityId);
      let node = await graph.getNode(entityId, context.scope);
      if (!node) node = await context.createGraphNode({ id: entityId, type: entity.type, name: entity.name, properties: { aliases: entity.aliases } });
      const edgeId = await stableUuid(`document-entity:${id}:${entityId}`);
      let edge = await graph.getEdge(edgeId, context.scope);
      if (!edge) { try { edge = await graph.createEdge({ id: edgeId, from: sourceNode.id, to: node.id, relation: "MENTIONS", confidence: 0.7, status: "candidate", properties: { sourceId: id }, scope: context.scope }); } catch (cause) { edge = await graph.getEdge(edgeId, context.scope); if (!edge) throw new PlanetProviderError(`document graph linking for '${entity.name}'`, cause); } }
      if (context.resolveEvidence("write")) {
        const prior = await context.requireEvidence("read").list({ edgeId, documentId: id, limit: 1, scope: context.scope });
        if (!prior.length) await context.requireEvidence("write").add({ id: await stableUuid(`document-evidence:${edgeId}`), edgeId, documentId: id, sourceType: "document", extractor: "entity-extractor", confidence: 0.7, metadata: { entity: entity.name }, scope: context.scope });
      }
    }
    for (const stale of await graph.neighbors({ nodeId: sourceNode.id, direction: "outbound", relation: "MENTIONS", scope: context.scope, limit: 1000 })) if (!desiredIds.has(stale.targetId)) await graph.deleteEdge(stale.id, context.scope);
  } });
  await checkpoint?.("knowledge_saved");
  return { document, chunks };
}
