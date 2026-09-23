import type {
  AddEvidenceInput, AddMemoryInput, BlobStorageAdapter, CreateDocumentInput, CreateEdgeInput, CreateNodeInput,
  DataLayerProvider, DocumentStore, EmbeddingProvider, EntityExtractor, Evidence, EvidenceListInput, EvidenceStore, GraphEdge, GraphNode, JsonObject,
  DocumentChunkStore, DocumentParser, GraphStore, GraphTraversal, IdentityStore, MemoryRecord, MemorySearchInput, MemoryStore, PlanetScope, ProviderCapability, ProviderOperation,
  IngestionCheckpoint, IngestionJob, IngestionJobStore, NodeMergeRecord, PlanetIdentity, IdentityBinding, ProviderRouting, ProviderRoutingPolicy, SqlStore, SqlTransaction, VectorSearchInput, VectorSearchResult, VectorStore,
} from "@unknown-planet/core";
import { withProviderSpan, withSpan } from "../observability/telemetry.js";
import type { SpanContext } from "@opentelemetry/api";
import { PlanetCapabilityError, PlanetConflictError, PlanetError, PlanetNotFoundError, PlanetProviderError, PlanetValidationError } from "../errors.js";
import { canonicalEntityName, entityNameSimilarity, stableUuid } from "./identity.js";
import { decodeBase64, encodeBase64 } from "./encoding.js";
import { decodeCursor, encodeCursor, pageById } from "./pagination.js";
import type { PlanetExtension } from "../extensions.js";
import type { DocumentIngestInput, DocumentIngestResult, EntityResolutionConfig, GraphSearchInput, GraphSearchResult, PlanetConfig, PlanetQueryInput, PlanetQueryResult, ProviderSelector, RetrievalConfig } from "../types.js";

/**
 * Storage-neutral application client. It provides deterministic graph and retrieval primitives;
 * it does not invoke an LLM or expose a database query language.
 */
export class Planet {
  private readonly providers: DataLayerProvider[];
  private readonly routing: ProviderRouting;
  private readonly scope: PlanetScope;
  private readonly routingPolicy?: ProviderRoutingPolicy;
  private readonly embeddingProvider?: EmbeddingProvider;
  private readonly entityExtractor?: EntityExtractor;
  private readonly documentParsers: Record<string, DocumentParser>;
  private readonly fuzzyEntityThreshold: number;
  private readonly embeddingEntityThreshold: number;
  private readonly providerSelector?: ProviderSelector;
  private readonly retrieval: RetrievalConfig;
  private readonly extensionRoutes: Readonly<Record<string, string>>;
  private readonly providerViews = new WeakMap<object, object>();
  private telemetryParent?: SpanContext;

  constructor(config: PlanetConfig) {
    const inline: DataLayerProvider = {
      id: "inline",
      graph: config.graph,
      vector: config.vector,
      documents: config.documents,
      chunks: config.chunks,
      evidence: config.evidence,
      memories: config.memories,
      ingestionJobs: config.ingestionJobs,
      identities: config.identities,
      blobs: config.blobs,
      sql: config.sql,
      extensions: config.extensions,
    };
    this.providers = [inline, ...(config.providers ?? [])].filter((provider) =>
      provider.graph || provider.vector || provider.documents || provider.chunks || provider.evidence || provider.memories || provider.ingestionJobs || provider.identities || provider.blobs || provider.sql || Object.keys(provider.extensions ?? {}).length > 0,
    );
    const ids = new Set<string>();
    for (const provider of this.providers) {
      if (ids.has(provider.id)) throw new PlanetConflictError(`Duplicate Unknown Planet provider id: ${provider.id}`);
      ids.add(provider.id);
    }
    this.providerSelector = config.selectProvider;
    this.routingPolicy = config.routingPolicy;
    this.routing = config.routing ?? {};
    this.scope = config.scope ?? { tenantId: "default" };
    this.retrieval = config.retrieval ?? {};
    this.extensionRoutes = this.routing.extensions ?? {};
    if (this.retrieval.graphDecay !== undefined && (this.retrieval.graphDecay < 0 || this.retrieval.graphDecay > 1)) {
      throw new PlanetValidationError("retrieval.graphDecay must be between 0 and 1.");
    }
    this.embeddingProvider = config.embeddings;
    this.entityExtractor = config.extractor;
    this.documentParsers = config.documentParsers ?? {};
    this.fuzzyEntityThreshold = config.entityResolution?.fuzzyThreshold ?? 0.9;
    if (this.fuzzyEntityThreshold < 0 || this.fuzzyEntityThreshold > 1) throw new PlanetValidationError("entityResolution.fuzzyThreshold must be between 0 and 1.");
    this.embeddingEntityThreshold = config.entityResolution?.embeddingThreshold ?? 0.92;
    if (this.embeddingEntityThreshold < 0 || this.embeddingEntityThreshold > 1) throw new PlanetValidationError("entityResolution.embeddingThreshold must be between 0 and 1.");
  }

  readonly graph = {
    node: {
      create: (input: CreateNodeInput) => this.requireGraph("write").createNode({ ...input, scope: this.scope }),
      get: (id: string) => this.requireGraph("read").getNode(id, this.scope),
      update: (id: string, input: Parameters<GraphStore["updateNode"]>[1]) => this.requireGraph("write").updateNode(id, { ...input, scope: this.scope }),
      delete: (id: string) => this.requireGraph("write").deleteNode(id, this.scope),
      merge: async (input: { sourceId: string; targetId: string }) => {
        if (input.sourceId === input.targetId) throw new PlanetConflictError("A node cannot be merged into itself.");
        const graph = this.requireGraph("write");
        if (!graph.mergeNodes) throw new PlanetCapabilityError("transactional graph merge support");
        const [source, target] = await Promise.all([graph.getNode(input.sourceId, this.scope), graph.getNode(input.targetId, this.scope)]);
        if (!source || !target) throw new PlanetNotFoundError("Both source and target nodes must exist in this scope.");
        return graph.mergeNodes({ ...input, scope: this.scope });
      },
      merges: (input: { nodeId?: string; limit?: number } = {}) => {
        const graph = this.requireGraph("read");
        if (!graph.listMerges) throw new PlanetCapabilityError("graph merge history");
        return graph.listMerges({ ...input, scope: this.scope });
      },
      mergesPage: async (input: { nodeId?: string; limit?: number; cursor?: string } = {}) => {
        const graph = this.requireGraph("read"); if (!graph.listMerges) throw new PlanetCapabilityError("graph merge history");
        const results = await graph.listMerges({ nodeId: input.nodeId, limit: 100000, scope: this.scope });
        return pageById<NodeMergeRecord>(results, input.cursor, Math.max(1, Math.min(input.limit ?? 100, 500)), (item) => item.sourceId);
      },
    },
    edge: {
      create: (input: CreateEdgeInput) => this.requireGraph("write").createEdge({ ...input, scope: this.scope }),
      get: (id: string) => this.requireGraph("read").getEdge(id, this.scope),
      update: (id: string, input: Parameters<GraphStore["updateEdge"]>[1]) => this.requireGraph("write").updateEdge(id, { ...input, scope: this.scope }),
      delete: (id: string) => this.requireGraph("write").deleteEdge(id, this.scope),
    },
    traverse: (input: Parameters<GraphStore["traverse"]>[0]) => this.requireGraph("read").traverse({ ...input, scope: this.scope }),
    search: (input: GraphSearchInput) => this.searchGraph(input),
    searchPage: async (input: GraphSearchInput & { cursor?: string }) => pageById(await this.searchGraph({ ...input, limit: 100000 }), input.cursor, Math.max(1, Math.min(input.limit ?? 20, 500)), (item) => item.node.id),
  };

  readonly memory = {
    add: (input: AddMemoryInput) => withSpan("planet.memory.add", {}, () => this.addMemory(input), this.telemetryParent),
    get: (id: string) => this.requireMemories("read").get(id, this.scope),
    delete: async (id: string) => {
      const current = await this.requireMemories("read").get(id, this.scope);
      if (!current) return false;
      await this.requireVector("write").delete({ id, namespace: "memory", scope: this.scope });
      await this.requireVector("write").delete({ id, namespace: this.retrieval.nodeNamespace ?? "node", scope: this.scope });
      await this.requireGraph("write").deleteNode(id, this.scope);
      return this.requireMemories("write").delete(id, this.scope);
    },
    search: (input: MemorySearchInput) => withSpan("planet.memory.search", {}, () => this.searchMemories(input), this.telemetryParent),
    searchPage: async (input: MemorySearchInput & { cursor?: string }) => {
      const store = this.requireMemories("search");
      if (!store.searchPage) throw new PlanetCapabilityError("cursor pagination on MemoryStore");
      const limit = Math.max(1, Math.min(input.limit ?? 20, 500));
      const page = await store.searchPage({ ...input, limit, afterId: decodeCursor(input.cursor), scope: this.scope });
      return { items: page.items, nextCursor: page.hasMore && page.items.length ? encodeCursor(page.items.at(-1)!.id) : undefined };
    },
  };

  readonly query = (input: PlanetQueryInput) => withSpan("planet.query", { "unknownplanet.search.keyword": input.search?.keyword ?? true, "unknownplanet.search.vector": input.search?.vector ?? true, "unknownplanet.search.graph": input.search?.graph ?? true }, () => this.queryKnowledge(input), this.telemetryParent);
  readonly queryPage = async (input: PlanetQueryInput & { cursor?: string }) => withSpan("planet.query.page", {}, async () => pageById(await this.queryKnowledge({ ...input, limit: 100000 }), input.cursor, Math.max(1, Math.min(input.limit ?? 20, 500)), (item) => item.node.id), this.telemetryParent);
  readonly ingestion = {
    get: (id: string) => this.requireIngestionJobs("read").get(id, this.scope),
    runDue: (input: { limit?: number; leaseMs?: number } = {}) => withSpan("planet.ingestion.run_due", {}, () => this.runDueIngestion(input), this.telemetryParent),
  };

  readonly vector = {
    upsert: (input: Parameters<VectorStore["upsert"]>[0]) => this.requireVector("write").upsert({ ...input, scope: this.scope }),
    search: (input: Parameters<VectorStore["search"]>[0]) => this.requireVector("search").search({ ...input, scope: this.scope }),
    searchPage: async (input: VectorSearchInput & { cursor?: string }) => pageById(await this.requireVector("search").search({ ...input, limit: 100000, scope: this.scope }), input.cursor, Math.max(1, Math.min(input.limit ?? 20, 500)), (item) => item.id),
    delete: (input: Parameters<VectorStore["delete"]>[0]) => this.requireVector("write").delete({ ...input, scope: this.scope }),
  };

  readonly document = {
    create: (input: CreateDocumentInput) => this.requireDocuments("write").create({ ...input, scope: this.scope }),
    get: (id: string) => this.requireDocuments("read").get(id, this.scope),
    chunk: {
      create: (input: Parameters<DocumentChunkStore["create"]>[0]) => this.requireChunks("write").create({ ...input, scope: this.scope }),
      get: (id: string) => this.requireChunks("read").get(id, this.scope),
      list: (input: Parameters<DocumentChunkStore["list"]>[0]) => this.requireChunks("read").list({ ...input, scope: this.scope }),
      listPage: async (input: { documentId: string; limit?: number; cursor?: string }) => {
        const store = this.requireChunks("read");
        if (!store.listPage) throw new PlanetCapabilityError("cursor pagination on DocumentChunkStore");
        const decoded = decodeCursor(input.cursor);
        const page = await store.listPage({ documentId: input.documentId, limit: Math.max(1, Math.min(input.limit ?? 100, 500)), afterId: decoded, scope: this.scope });
        return { items: page.items, nextCursor: page.hasMore && page.items.length ? encodeCursor(page.items.at(-1)!.id) : undefined };
      },
      search: (input: Parameters<DocumentChunkStore["search"]>[0]) => this.requireChunks("search").search({ ...input, scope: this.scope }),
      searchPage: async (input: { query: string; limit?: number; cursor?: string }) => pageById(await this.requireChunks("search").search({ query: input.query, limit: 100000, scope: this.scope }), input.cursor, Math.max(1, Math.min(input.limit ?? 20, 500)), (item) => item.id),
      deleteExcept: (input: Parameters<DocumentChunkStore["deleteExcept"]>[0]) => this.requireChunks("write").deleteExcept({ ...input, scope: this.scope }),
    },
    ingest: (input: DocumentIngestInput) => withSpan("planet.document.ingest", { "unknownplanet.document.content_type": input.contentType }, () => this.ingestDocument(input), this.telemetryParent),
  };

  readonly evidence = {
    add: async (input: AddEvidenceInput) => {
      const saved = await this.requireEvidence("write").add({ ...input, scope: this.scope });
      const edge = await this.requireGraph("read").getEdge(input.edgeId, this.scope);
      if (edge && input.direction !== "neutral") {
        const current = edge.confidence ?? 0.5;
        const weight = (input.confidence ?? 0.5) * (input.strength ?? input.confidence ?? 0.5);
        const next = input.direction === "contradict" ? current * (1 - weight) : 1 - (1 - current) * (1 - weight);
        const status = input.direction === "contradict" ? "disputed" : next >= 0.75 ? "canonical" : edge.status;
        await this.requireGraph("write").updateEdge(input.edgeId, { confidence: Math.max(0, Math.min(1, next)), status, scope: this.scope });
      }
      return saved;
    },
    list: (input: Parameters<EvidenceStore["list"]>[0]) => this.requireEvidence("read").list({ ...input, scope: this.scope }),
    listPage: async (input: EvidenceListInput & { cursor?: string }) => pageById(await this.requireEvidence("read").list({ ...input, limit: 100000, scope: this.scope }), input.cursor, Math.max(1, Math.min(input.limit ?? 100, 500)), (item) => item.id),
  };

  readonly nameId = {
    create: (input: Parameters<IdentityStore["create"]>[0]) => this.requireIdentities("write").create({ ...input, scope: this.scope }),
    get: (input: Parameters<IdentityStore["get"]>[0]) => this.requireIdentities("read").get({ ...input, scope: this.scope }),
    resolve: (input: Parameters<IdentityStore["resolve"]>[0]) => this.requireIdentities("read").resolve({ ...input, scope: this.scope }),
    list: (input: Parameters<IdentityStore["list"]>[0]) => this.requireIdentities("read").list({ ...input, scope: this.scope }),
    listPage: async (input: Parameters<IdentityStore["list"]>[0] & { cursor?: string }) => pageById<PlanetIdentity>(await this.requireIdentities("read").list({ ...input, limit: 100000, scope: this.scope }), input.cursor, Math.max(1, Math.min(input.limit ?? 100, 500)), (item) => item.id),
    alias: { add: (input: Parameters<IdentityStore["addAlias"]>[0]) => this.requireIdentities("write").addAlias({ ...input, scope: this.scope }) },
    bind: (input: Parameters<IdentityStore["bind"]>[0]) => this.requireIdentities("write").bind({ ...input, scope: this.scope }),
    bindings: {
      list: (input: Parameters<IdentityStore["listBindings"]>[0]) => this.requireIdentities("read").listBindings({ ...input, scope: this.scope }),
      listPage: async (input: Parameters<IdentityStore["listBindings"]>[0] & { cursor?: string }) => pageById<IdentityBinding>(await this.requireIdentities("read").listBindings({ ...input, limit: 100000, scope: this.scope }), input.cursor, Math.max(1, Math.min(input.limit ?? 100, 500)), (item) => JSON.stringify([item.identityId, item.providerId, item.resourceType, item.resourceId])),
    },
  };

  readonly blob = {
    put: (input: Parameters<BlobStorageAdapter["put"]>[0]) => this.requireBlobs("write").put(input),
    get: (uri: string) => this.requireBlobs("read").get(uri),
    delete: (uri: string) => this.requireBlobs("write").delete(uri),
  };

  /** Execute parameterized SQL against the routed relational provider. */
  readonly sql = {
    query: <T extends Record<string, unknown> = Record<string, unknown>>(input: Parameters<SqlStore["query"]>[0]) => this.requireSql("read").query<T>(input),
    transaction: <T>(work: (transaction: SqlTransaction) => Promise<T>) => {
      const store = this.requireSql("transaction");
      if (!store.transaction) throw new PlanetCapabilityError("transaction support on the routed SqlStore");
      return store.transaction(work);
    },
  };

  /**
   * Retrieves an application-defined provider extension without adding it to the core SDK.
   * Pass a provider id to bypass configured extension routing.
   */
  extension<T>(extension: PlanetExtension<T>, providerId?: string): T;
  extension<T = unknown>(extension: string, providerId?: string): T;
  extension<T>(extension: string | PlanetExtension<T>, providerId?: string): T {
    const key = typeof extension === "string" ? extension : extension.key;
    const selectedId = providerId ?? this.extensionRoute(key);
    const provider = selectedId
      ? this.providers.find((item) => item.id === selectedId)
      : this.providers.find((item) => Object.hasOwn(item.extensions ?? {}, key));
    if (selectedId && !provider) throw new PlanetNotFoundError(`Unknown Planet provider '${selectedId}' is not registered.`);
    if (!provider || !Object.hasOwn(provider.extensions ?? {}, key)) {
      throw new PlanetCapabilityError(`provider extension '${key}'`);
    }
    return provider.extensions![key] as T;
  }

  /** Returns a client using the same providers with a different capability routing policy. */
  withRouting(routing: ProviderRouting): Planet {
    return new Planet({ providers: this.providers, routing, embeddings: this.embeddingProvider, extractor: this.entityExtractor, documentParsers: this.documentParsers, entityResolution: { fuzzyThreshold: this.fuzzyEntityThreshold, embeddingThreshold: this.embeddingEntityThreshold }, selectProvider: this.providerSelector, routingPolicy: this.routingPolicy, scope: this.scope, retrieval: this.retrieval });
  }

  /** Returns a client with additional adapters. Existing provider ids remain protected from duplicates. */
  withProviders(providers: DataLayerProvider[], routing?: ProviderRouting): Planet {
    return new Planet({ providers: [...this.providers, ...providers], routing: routing ?? this.routing, embeddings: this.embeddingProvider, extractor: this.entityExtractor, documentParsers: this.documentParsers, entityResolution: { fuzzyThreshold: this.fuzzyEntityThreshold, embeddingThreshold: this.embeddingEntityThreshold }, selectProvider: this.providerSelector, routingPolicy: this.routingPolicy, scope: this.scope, retrieval: this.retrieval });
  }

  /** Returns an isolated client for one tenant or tenant/workspace request. */
  withScope(scope: PlanetScope, parentSpanContext?: SpanContext): Planet {
    if (!scope.tenantId.trim()) throw new PlanetValidationError("Planet scope requires a tenantId.");
    const scoped = new Planet({ providers: this.providers, routing: this.routing, embeddings: this.embeddingProvider, extractor: this.entityExtractor, documentParsers: this.documentParsers, entityResolution: { fuzzyThreshold: this.fuzzyEntityThreshold, embeddingThreshold: this.embeddingEntityThreshold }, selectProvider: this.providerSelector, routingPolicy: this.routingPolicy, scope, retrieval: this.retrieval });
    scoped.telemetryParent = parentSpanContext;
    return scoped;
  }

  private resolve<K extends ProviderCapability>(
    capability: K,
    operation: ProviderOperation,
  ): NonNullable<DataLayerProvider[K]> | undefined {
    const configuredId = this.routing[capability];
    const selectedId = configuredId ?? this.routingPolicy?.({ capability, operation, scope: this.scope, providers: this.providers }) ?? this.providerSelector?.({ capability, providers: this.providers });
    const provider = selectedId ? this.providers.find((item) => item.id === selectedId) : this.providers.find((item) => item[capability]);
    if (selectedId && !provider) throw new PlanetNotFoundError(`Unknown Planet provider '${selectedId}' is not registered.`);
    if (selectedId && !provider?.[capability]) throw new PlanetCapabilityError(`'${capability}' on provider '${selectedId}'`);
    const store = provider?.[capability] as NonNullable<DataLayerProvider[K]> | undefined;
    return store ? this.providerView(capability, store as object) as NonNullable<DataLayerProvider[K]> : undefined;
  }

  private providerView<T extends object>(capability: string, store: T): T {
    const cached = this.providerViews.get(store);
    if (cached) return cached as T;
    const view = new Proxy(store, {
      get: (target, property) => {
        const value = Reflect.get(target, property, target) as unknown;
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => withProviderSpan(`store.${capability}`, String(property), async () => {
          try { return await Reflect.apply(value, target, args); }
          catch (error) { throw this.classifyProviderError(capability, String(property), error); }
        });
      },
    });
    this.providerViews.set(store, view);
    return view;
  }

  private classifyProviderError(capability: string, method: string, error: unknown): PlanetError {
    if (error instanceof PlanetError) return error;
    const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
    const message = error instanceof Error ? error.message : "Storage provider failed.";
    if (code === "23505" || code === "11000") return new PlanetConflictError(message);
    if (code === "23503" || code === "P0002") return new PlanetNotFoundError(message);
    if (code.startsWith("22") || code === "VALIDATION") return new PlanetValidationError(message);
    if (/does not exist|not found|must exist/i.test(message)) return new PlanetNotFoundError(message);
    if (/must be|requires|invalid|cannot be empty|cannot be moved|must contain/i.test(message)) return new PlanetValidationError(message);
    return new PlanetProviderError(`${capability}.${method}`, error);
  }
  private async providerCall<T>(capability: string, method: string, call: () => Promise<T>): Promise<T> {
    try { return await withProviderSpan(capability, method, call, capability === "EmbeddingProvider" ? this.embeddingProvider?.model : undefined); } catch (error) { throw this.classifyProviderError(capability, method, error); }
  }

  private extensionRoute(key: string): string | undefined {
    // Routing is stored on construction through the extension provider selection below.
    return this.extensionRoutes[key];
  }

  private requireGraph(operation: ProviderOperation): GraphStore {
    const store = this.resolve("graph", operation); if (!store) throw new PlanetCapabilityError("GraphStore"); return store;
  }

  private requireVector(operation: ProviderOperation): VectorStore {
    const store = this.resolve("vector", operation); if (!store) throw new PlanetCapabilityError("VectorStore"); return store;
  }
  private requireDocuments(operation: ProviderOperation): DocumentStore {
    const store = this.resolve("documents", operation); if (!store) throw new PlanetCapabilityError("DocumentStore"); return store;
  }
  private requireChunks(operation: ProviderOperation): DocumentChunkStore {
    const store = this.resolve("chunks", operation); if (!store) throw new PlanetCapabilityError("DocumentChunkStore"); return store;
  }
  private requireEvidence(operation: ProviderOperation): EvidenceStore {
    const store = this.resolve("evidence", operation); if (!store) throw new PlanetCapabilityError("EvidenceStore"); return store;
  }
  private requireMemories(operation: ProviderOperation): MemoryStore {
    const store = this.resolve("memories", operation); if (!store) throw new PlanetCapabilityError("MemoryStore"); return store;
  }
  private requireIngestionJobs(operation: ProviderOperation): IngestionJobStore {
    const store = this.resolve("ingestionJobs", operation); if (!store) throw new PlanetCapabilityError("IngestionJobStore"); return store;
  }
  private async resolveEntityIdentity(entity: { name: string; type: string; aliases: string[] }) {
    const store = this.resolve("identities", "write");
    if (!store) return null;
    const namespace = `entity:${entity.type}`;
    let identity = await store.resolve({ namespace, name: entity.name, scope: this.scope });
    if (!identity && typeof store.list === "function") {
      const candidates = await store.list({ namespace, limit: 500, scope: this.scope });
      const scored = candidates.map((candidate) => ({ candidate, score: entityNameSimilarity(entity.name, candidate.name) }))
        .filter((item) => item.score >= this.fuzzyEntityThreshold)
        .sort((left, right) => right.score - left.score || left.candidate.id.localeCompare(right.candidate.id));
      if (scored.length && (scored.length === 1 || scored[0]!.score > scored[1]!.score)) identity = scored[0]!.candidate;
      if (!identity && this.embeddingProvider && this.resolve("vector", "search")) {
        const embedding = await this.providerCall("EmbeddingProvider", "embed", () => this.embeddingProvider!.embed({ text: entity.name }));
        const vectorCandidates = await this.requireVector("search").search({
          embedding,
          namespace: `identity:${entity.type}`,
          limit: 10,
          model: this.embeddingProvider.model,
          scope: this.scope,
        });
        const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
        const matches = vectorCandidates.filter((item) => item.score >= this.embeddingEntityThreshold && byId.has(item.id));
        if (matches.length && (matches.length === 1 || matches[0]!.score > matches[1]!.score)) identity = byId.get(matches[0]!.id) ?? null;
      }
    }
    if (!identity) {
      if (typeof store.resolveOrCreate === "function") identity = await store.resolveOrCreate({ namespace, name: entity.name, canonicalName: canonicalEntityName(entity.name), fuzzyThreshold: this.fuzzyEntityThreshold, scope: this.scope });
      else {
        try { identity = await store.create({ namespace, name: entity.name, scope: this.scope }); }
        catch (cause) { identity = await store.resolve({ namespace, name: entity.name, scope: this.scope }); if (!identity) throw new PlanetProviderError(`entity identity resolution for '${entity.name}'`, cause); }
      }
    }
    for (const alias of [...new Set([entity.name, canonicalEntityName(entity.name), ...entity.aliases])]) {
      if (alias === identity.name) continue;
      try { await store.addAlias({ namespace, alias, identityId: identity.id, scope: this.scope }); }
      catch (error) {
        const resolved = await store.resolve({ namespace, name: alias, scope: this.scope });
        if (resolved?.id === identity.id) continue;
        if (resolved) throw new PlanetConflictError(`Alias '${alias}' is already assigned to another entity.`);
        throw error;
      }
    }
    if (this.embeddingProvider && this.resolve("vector", "write")) {
      const embedding = await this.providerCall("EmbeddingProvider", "embed", () => this.embeddingProvider!.embed({ text: identity.name }));
      await this.requireVector("write").upsert({
        id: identity.id,
        namespace: `identity:${entity.type}`,
        embedding,
        model: this.embeddingProvider.model,
        metadata: { entityType: entity.type, canonicalName: identity.name },
        scope: this.scope,
      });
    }
    return identity;
  }
  private requireIdentities(operation: ProviderOperation): IdentityStore {
    const store = this.resolve("identities", operation); if (!store) throw new PlanetCapabilityError("IdentityStore"); return store;
  }
  private requireBlobs(operation: ProviderOperation): BlobStorageAdapter {
    const store = this.resolve("blobs", operation); if (!store) throw new PlanetCapabilityError("BlobStorageAdapter"); return store;
  }
  private requireSql(operation: ProviderOperation): SqlStore {
    const store = this.resolve("sql", operation); if (!store) throw new PlanetCapabilityError("SqlStore"); return store;
  }

  private async createGraphNode(input: CreateNodeInput): Promise<GraphNode> {
    const graph = this.requireGraph("write");
    try { return await graph.createNode({ ...input, scope: this.scope }); }
    catch (error) {
      if (input.id) {
        const concurrent = await graph.getNode(input.id, this.scope);
        if (concurrent) return concurrent;
      }
      throw error;
    }
  }

  private async extractEntities(text: string) {
    if (!this.entityExtractor) return [];
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const entities = await this.providerCall("EntityExtractor", "extract", () => this.entityExtractor!.extract({ text }));
        if (!Array.isArray(entities) || entities.some((item) => !item || typeof item.name !== "string" || !item.name.trim() || typeof item.type !== "string" || !item.type.trim() || (item.aliases !== undefined && (!Array.isArray(item.aliases) || item.aliases.some((alias) => typeof alias !== "string"))))) throw new PlanetValidationError("Entity extractor returned an invalid entity list.");
        const unique = new Map<string, { name: string; type: string; aliases: string[] }>();
        for (const item of entities) {
          const key = item.name.trim().normalize("NFKC").toLocaleLowerCase();
          const previous = unique.get(key);
          unique.set(key, { name: previous?.name ?? item.name.trim().normalize("NFKC"), type: previous?.type ?? item.type.trim(), aliases: [...new Set([...(previous?.aliases ?? []), ...(item.aliases ?? []).map((alias) => alias.trim()).filter(Boolean)])] });
        }
        return [...unique.values()];
      } catch (error) { lastError = error; }
    }
    throw lastError;
  }

  private async ingestDocument(input: DocumentIngestInput): Promise<DocumentIngestResult> {
    const jobs = this.resolve("ingestionJobs", "write");
    if (!jobs) return this.ingestDocumentCore(input);
    const jobId = crypto.randomUUID();
    const payload: JsonObject = {
      title: input.title,
      contentType: input.contentType,
      dataBase64: encodeBase64(input.data),
      contentUri: input.contentUri ?? null,
      externalId: input.externalId ?? null,
      chunkSize: input.chunkSize ?? null,
      overlap: input.overlap ?? null,
      metadata: (input.metadata ?? {}) as JsonObject,
    };
    let job = await jobs.create({ id: jobId, kind: "document", input: payload, scope: this.scope });
    job = await jobs.update({ id: jobId, status: "processing", attempts: 1, leaseUntil: new Date(Date.now() + 60_000), lastError: null, scope: this.scope });
    return this.executeDocumentJob(job, input);
  }

  private async runDueIngestion(input: { limit?: number; leaseMs?: number }) {
    const store = this.requireIngestionJobs("write");
    const jobs = await store.claimDue({ ...input, scope: this.scope });
    const results: Array<{ id: string; status: string; error?: string }> = [];
    for (const job of jobs) {
      try {
        if (job.kind === "document") await this.executeDocumentJob(job, this.documentInputFromJob(job));
        else await this.executeMemoryJob(job, this.memoryInputFromJob(job));
        results.push({ id: job.id, status: "succeeded" });
      }
      catch (error) { results.push({ id: job.id, status: (await store.get(job.id, this.scope))?.status ?? "failed", error: error instanceof Error ? error.message : "Ingestion failed." }); }
    }
    return { claimed: jobs.length, results };
  }

  private documentInputFromJob(job: IngestionJob): DocumentIngestInput {
    const value = job.input;
    if (typeof value.title !== "string" || typeof value.contentType !== "string" || typeof value.dataBase64 !== "string") throw new PlanetValidationError(`Ingestion job '${job.id}' has an invalid persisted payload.`);
    return { title: value.title, contentType: value.contentType, data: decodeBase64(value.dataBase64), contentUri: typeof value.contentUri === "string" ? value.contentUri : undefined, externalId: typeof value.externalId === "string" ? value.externalId : undefined, chunkSize: typeof value.chunkSize === "number" ? value.chunkSize : undefined, overlap: typeof value.overlap === "number" ? value.overlap : undefined, metadata: value.metadata && typeof value.metadata === "object" && !Array.isArray(value.metadata) ? value.metadata as Record<string, unknown> : undefined };
  }

  private async executeDocumentJob(job: IngestionJob, input: DocumentIngestInput): Promise<DocumentIngestResult> {
    const store = this.requireIngestionJobs("write");
    const checkpoint = async (value: IngestionCheckpoint) => { await store.update({ id: job.id, checkpoint: value, leaseUntil: new Date(Date.now() + 60_000), scope: this.scope }); };
    const heartbeat = setInterval(() => { void store.update({ id: job.id, leaseUntil: new Date(Date.now() + 60_000), scope: this.scope }).catch(() => undefined); }, 20_000);
    try {
      const result = await this.ingestDocumentCore(input, checkpoint);
      await store.update({ id: job.id, status: "succeeded", checkpoint: "completed", leaseUntil: null, lastError: null, scope: this.scope });
      return { ...result, jobId: job.id };
    } catch (error) {
      const failure = error instanceof PlanetError ? error : new PlanetProviderError("document ingestion", error);
      const attempts = Math.max(job.attempts, 1); const retry = attempts < job.maxAttempts && !(failure instanceof PlanetValidationError);
      try { await store.update({ id: job.id, status: retry ? "retry_wait" : "failed", nextAttemptAt: retry ? new Date(Date.now() + Math.min(3_600_000, 1000 * 2 ** attempts)) : undefined, leaseUntil: null, lastError: failure.message.slice(0, 2000), scope: this.scope }); } catch { /* preserve the original failure; the lease allows recovery if status persistence failed */ }
      if (!retry && typeof job.input.documentId === "string") {
        const cleanupErrors = await this.cleanupFailedDocument(job.input.documentId);
        if (cleanupErrors.length) try { await store.update({ id: job.id, lastError: `${failure.message}; cleanup incomplete: ${cleanupErrors.join("; ")}`.slice(0, 2000), scope: this.scope }); } catch { /* Retain the original job error. */ }
      }
      Object.assign(failure, { ingestionJobId: job.id });
      throw failure;
    } finally { clearInterval(heartbeat); }
  }

  private memoryInputFromJob(job: IngestionJob): AddMemoryInput {
    const value = job.input;
    if (typeof value.agentId !== "string" || typeof value.content !== "string") throw new PlanetValidationError(`Memory ingestion job '${job.id}' has an invalid persisted payload.`);
    return { id: typeof value.memoryId === "string" ? value.memoryId : undefined, agentId: value.agentId, content: value.content, type: typeof value.type === "string" ? value.type as AddMemoryInput["type"] : undefined, userId: typeof value.userId === "string" ? value.userId : undefined, sessionId: typeof value.sessionId === "string" ? value.sessionId : undefined, importance: typeof value.importance === "number" ? value.importance : undefined, confidence: typeof value.confidence === "number" ? value.confidence : undefined, source: value.source && typeof value.source === "object" && !Array.isArray(value.source) ? value.source as unknown as AddMemoryInput["source"] : undefined, metadata: value.metadata && typeof value.metadata === "object" && !Array.isArray(value.metadata) ? value.metadata as JsonObject : undefined };
  }

  private async executeMemoryJob(job: IngestionJob, input: AddMemoryInput): Promise<MemoryRecord> {
    const store = this.requireIngestionJobs("write");
    const checkpoint = async (value: IngestionCheckpoint, documentId?: string) => { await store.update({ id: job.id, checkpoint: value, ...(documentId ? { input: { ...job.input, documentId } } : {}), leaseUntil: new Date(Date.now() + 60_000), scope: this.scope }); if (documentId) job.input.documentId = documentId; };
    const heartbeat = setInterval(() => { void store.update({ id: job.id, leaseUntil: new Date(Date.now() + 60_000), scope: this.scope }).catch(() => undefined); }, 20_000);
    try {
      const record = await this.addMemoryCore(input, checkpoint);
      await store.update({ id: job.id, status: "succeeded", checkpoint: "completed", leaseUntil: null, lastError: null, scope: this.scope });
      return record;
    } catch (error) {
      const failure = error instanceof PlanetError ? error : new PlanetProviderError("memory ingestion", error);
      const retry = job.attempts < job.maxAttempts && !(failure instanceof PlanetValidationError);
      try { await store.update({ id: job.id, status: retry ? "retry_wait" : "failed", nextAttemptAt: retry ? new Date(Date.now() + Math.min(3_600_000, 1000 * 2 ** job.attempts)) : undefined, leaseUntil: null, lastError: failure.message.slice(0, 2000), scope: this.scope }); } catch { /* Preserve the original error; the lease allows recovery. */ }
      if (!retry) {
        try {
          const existing = await this.resolve("memories", "read")?.get(input.id ?? "", this.scope);
          if (existing) await this.memory.delete(existing.id);
        } catch { /* Keep the job terminal and retain the original failure for operator repair. */ }
      }
      Object.assign(failure, { ingestionJobId: job.id });
      throw failure;
    } finally { clearInterval(heartbeat); }
  }

  private async addMemory(input: AddMemoryInput): Promise<MemoryRecord> {
    const jobs = this.resolve("ingestionJobs", "write");
    if (!jobs) return this.addMemoryCore(input);
    const memoryId = input.id ?? (input.source ? await stableUuid(`memory:${this.scope.tenantId}:${this.scope.workspaceId ?? ""}:${input.source.type}:${input.source.id}`) : crypto.randomUUID());
    const jobId = await stableUuid(`memory-job:${this.scope.tenantId}:${this.scope.workspaceId ?? ""}:${memoryId}`);
    const payload: JsonObject = { memoryId, agentId: input.agentId, content: input.content, type: input.type ?? "fact", userId: input.userId ?? null, sessionId: input.sessionId ?? null, importance: input.importance ?? null, confidence: input.confidence ?? null, source: (input.source ?? null) as unknown as JsonObject, metadata: (input.metadata ?? {}) as JsonObject };
    let job = await jobs.create({ id: jobId, kind: "memory", input: payload, scope: this.scope });
    job = await jobs.update({ id: jobId, status: "processing", attempts: 1, leaseUntil: new Date(Date.now() + 60_000), lastError: null, scope: this.scope });
    return this.executeMemoryJob(job, { ...input, id: memoryId });
  }

  private async cleanupFailedDocument(documentId: string): Promise<string[]> {
    const failures: string[] = [];
    let chunks: Awaited<ReturnType<DocumentChunkStore["list"]>> = [];
    try { chunks = await this.requireChunks("read").list({ documentId, limit: 100000, scope: this.scope }); } catch (error) { failures.push(`chunks lookup: ${error instanceof Error ? error.message : "failed"}`); }
    if (this.resolve("vector", "write")) for (const chunk of chunks) {
      try { await this.requireVector("write").delete({ id: chunk.id, namespace: "document-chunk", scope: this.scope }); } catch (error) { failures.push(`vector ${chunk.id}: ${error instanceof Error ? error.message : "failed"}`); }
    }
    try { await this.resolve("evidence", "write")?.deleteByDocument?.({ documentId, scope: this.scope }); } catch (error) { failures.push(`evidence: ${error instanceof Error ? error.message : "failed"}`); }
    try { await this.resolve("graph", "write")?.deleteNode(documentId, this.scope); } catch (error) { failures.push(`graph node: ${error instanceof Error ? error.message : "failed"}`); }
    const documents = this.resolve("documents", "write");
    if (documents?.delete) try { await documents.delete(documentId, this.scope); } catch (error) { failures.push(`document: ${error instanceof Error ? error.message : "failed"}`); }
    else failures.push("document adapter does not support deletion");
    return failures;
  }

  private async ingestDocumentCore(input: DocumentIngestInput, checkpoint?: (value: IngestionCheckpoint, documentId?: string) => Promise<void>): Promise<DocumentIngestResult> {
    const contentType = input.contentType.split(";")[0]!.trim().toLowerCase();
    const text = await withSpan("planet.ingestion.parse", { "unknownplanet.document.content_type": contentType }, async () => {
      const parse = this.documentParsers[contentType];
      let parsedText: string;
      if (parse) parsedText = await this.providerCall("DocumentParser", "parse", () => Promise.resolve(parse.parse({ data: input.data, contentType })));
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
    const id = await stableUuid(`document:${this.scope.tenantId}:${this.scope.workspaceId ?? ""}:${input.externalId ?? input.contentUri ?? `${contentType}:${text}`}`);
    const document = await this.requireDocuments("write").create({ id, externalId: input.externalId, title: input.title, contentUri: input.contentUri ?? `unknownplanet://document/${id}`, metadata: (input.metadata ?? {}) as JsonObject, scope: this.scope });
    await checkpoint?.("document_saved", id);
    const previousChunks = await this.requireChunks("read").list({ documentId: id, limit: 100000, scope: this.scope });
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
        const chunk = await this.requireChunks("write").create({ id: chunkId, documentId: id, text: body, startOffset: sourceStart, endOffset: sourceEnd, metadata: { index, contentType }, scope: this.scope });
        created.push(chunk);
      }
      return created;
    });
    await checkpoint?.("chunks_saved");
    await withSpan("planet.ingestion.embed_and_index", { "unknownplanet.chunk.count": chunks.length }, async () => {
      if (this.embeddingProvider) for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index]!;
        const body = chunk.text ?? "";
        const embedding = await this.providerCall("EmbeddingProvider", "embed", () => this.embeddingProvider!.embed({ text: body }));
        if (!embedding.length || embedding.some((value) => !Number.isFinite(value))) throw new PlanetValidationError("EmbeddingProvider returned an invalid embedding.");
        await this.requireVector("write").upsert({ id: chunk.id, namespace: "document-chunk", model: this.embeddingProvider.model, embedding, metadata: { documentId: id, index }, scope: this.scope });
      }
    });
    await checkpoint?.("vectors_saved");
    const keptChunkIds = new Set(chunks.map((chunk) => chunk.id));
    for (const previous of previousChunks) if (!keptChunkIds.has(previous.id) && this.resolve("vector", "write")) await this.requireVector("write").delete({ id: previous.id, namespace: "document-chunk", scope: this.scope });
    await this.requireChunks("write").deleteExcept({ documentId: id, keepIds: [...keptChunkIds], scope: this.scope });
    await withSpan("planet.ingestion.knowledge", {}, async () => { if (this.entityExtractor) {
      const entities = await this.extractEntities(text); const graph = this.requireGraph("write");
      let sourceNode = await graph.getNode(id, this.scope);
      if (!sourceNode) sourceNode = await this.createGraphNode({ id, type: "document", name: input.title, properties: { documentId: id } });
      else await graph.updateNode(id, { type: "document", name: input.title, properties: { documentId: id }, scope: this.scope });
      const desiredIds = new Set<string>();
      for (const entity of entities) {
        const identity = await this.resolveEntityIdentity(entity);
        const entityId = identity?.id ?? await stableUuid(`entity:${this.scope.tenantId}:${this.scope.workspaceId ?? ""}:${entity.type}:${entity.name.normalize("NFKC").toLocaleLowerCase()}`);
        desiredIds.add(entityId);
        let node = await graph.getNode(entityId, this.scope);
        if (!node) node = await this.createGraphNode({ id: entityId, type: entity.type, name: entity.name, properties: { aliases: entity.aliases } });
        const edgeId = await stableUuid(`document-entity:${id}:${entityId}`);
        let edge = await graph.getEdge(edgeId, this.scope);
        if (!edge) { try { edge = await graph.createEdge({ id: edgeId, from: sourceNode.id, to: node.id, relation: "MENTIONS", confidence: 0.7, status: "candidate", properties: { sourceId: id }, scope: this.scope }); } catch (cause) { edge = await graph.getEdge(edgeId, this.scope); if (!edge) throw new PlanetProviderError(`document graph linking for '${entity.name}'`, cause); } }
        if (this.resolve("evidence", "write")) {
          const prior = await this.requireEvidence("read").list({ edgeId, documentId: id, limit: 1, scope: this.scope });
          if (!prior.length) await this.requireEvidence("write").add({ id: await stableUuid(`document-evidence:${edgeId}`), edgeId, documentId: id, sourceType: "document", extractor: "entity-extractor", confidence: 0.7, metadata: { entity: entity.name }, scope: this.scope });
        }
      }
      for (const stale of await graph.neighbors({ nodeId: sourceNode.id, direction: "outbound", relation: "MENTIONS", scope: this.scope, limit: 1000 })) if (!desiredIds.has(stale.targetId)) await graph.deleteEdge(stale.id, this.scope);
    } });
    await checkpoint?.("knowledge_saved");
    return { document, chunks };
  }

  private async addMemoryCore(input: AddMemoryInput, checkpoint?: (value: IngestionCheckpoint) => Promise<void>): Promise<MemoryRecord> {
    if (!input.agentId.trim() || !input.content.trim()) throw new PlanetValidationError("Memory requires a non-empty agentId and content.");
    for (const [key, value] of [["importance", input.importance], ["confidence", input.confidence]] as const) if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 1)) throw new PlanetValidationError(`Memory ${key} must be between 0 and 1.`);
    const id = input.id ?? (input.source ? await stableUuid(`memory:${this.scope.tenantId}:${this.scope.workspaceId ?? ""}:${input.source.type}:${input.source.id}`) : crypto.randomUUID());
    const [embedding, entities] = await Promise.all([
      this.embeddingProvider ? this.providerCall("EmbeddingProvider", "embed", () => this.embeddingProvider!.embed({ text: input.content })) : Promise.reject(new PlanetCapabilityError("EmbeddingProvider")),
      this.extractEntities(input.content),
    ]);
    if (!embedding.length || embedding.some((value) => !Number.isFinite(value))) throw new PlanetValidationError("EmbeddingProvider returned an invalid embedding.");
    const record = await this.requireMemories("write").add({ ...input, id, content: input.content.trim(), scope: this.scope });
    await checkpoint?.("memory_saved");
    await this.requireVector("write").upsert({ id, namespace: "memory", embedding, model: this.embeddingProvider?.model, metadata: { agentId: record.agentId, userId: record.userId ?? "", sessionId: record.sessionId ?? "", type: record.type }, scope: this.scope });
    await this.requireVector("write").upsert({ id, namespace: this.retrieval.nodeNamespace ?? "node", embedding, model: this.embeddingProvider?.model, metadata: { type: "memory", agentId: record.agentId }, scope: this.scope });
    await checkpoint?.("vectors_saved");
    const graph = this.requireGraph("write");
    let memoryNode = await graph.getNode(id, this.scope);
    if (!memoryNode) memoryNode = await this.createGraphNode({ id, type: "memory", name: record.content.slice(0, 120), properties: { agentId: record.agentId, memoryType: record.type, source: record.source ? { type: record.source.type, id: record.source.id } : null }, embedding });
    else await graph.updateNode(id, { type: "memory", name: record.content.slice(0, 120), properties: { agentId: record.agentId, memoryType: record.type, source: record.source ? { type: record.source.type, id: record.source.id } : null }, embedding, scope: this.scope });
    const desiredEntityIds = new Set<string>();
    for (const entity of entities) {
      const identity = await this.resolveEntityIdentity(entity);
      const entityId = identity?.id ?? await stableUuid(`entity:${this.scope.tenantId}:${this.scope.workspaceId ?? ""}:${entity.type}:${entity.name.normalize("NFKC").toLocaleLowerCase()}`);
      desiredEntityIds.add(entityId);
      let entityNode = await graph.getNode(entityId, this.scope);
      if (!entityNode) {
        const matches = await graph.searchNodes({ query: entity.name, limit: 20, scope: this.scope });
        entityNode = matches.find((candidate) => candidate.type === entity.type && candidate.name.normalize("NFKC").toLocaleLowerCase() === entity.name.normalize("NFKC").toLocaleLowerCase()) ?? null;
        if (!entityNode) entityNode = await this.createGraphNode({ id: entityId, type: entity.type, name: entity.name, properties: { aliases: entity.aliases } });
      }
      const currentEdges = await graph.neighbors({ nodeId: memoryNode.id, direction: "outbound", relation: "MENTIONS", limit: 1000, scope: this.scope });
      let edge: GraphEdge | null | undefined = currentEdges.find((item) => item.targetId === entityNode.id);
      if (!edge) {
        const edgeId = await stableUuid(`memory-entity:${id}:${entityNode.id}`);
        try { edge = await graph.createEdge({ id: edgeId, from: memoryNode.id, to: entityNode.id, relation: "MENTIONS", confidence: record.confidence ?? 1, properties: { sourceId: id }, scope: this.scope }); }
        catch (cause) { edge = await graph.getEdge(edgeId, this.scope); if (!edge) throw new PlanetProviderError(`memory graph linking for '${entity.name}'`, cause); }
      }
      const evidenceId = await stableUuid(`memory-evidence:${id}:${edge.id}`);
      if (this.resolve("evidence", "write")) {
        const prior = await this.resolve("evidence", "read")!.list({ edgeId: edge.id, sourceId: id, scope: this.scope, limit: 1 });
        if (!prior.length) {
          try { await this.requireEvidence("write").add({ id: evidenceId, edgeId: edge.id, sourceId: id, sourceType: record.source?.type ?? "memory", extractor: this.entityExtractor ? "entity-extractor" : "memory-ingestion", confidence: record.confidence, metadata: { entity: entity.name }, scope: this.scope }); }
          catch (cause) { if (!(await this.requireEvidence("read").list({ edgeId: edge.id, sourceId: id, scope: this.scope, limit: 1 })).length) throw new PlanetProviderError(`memory evidence attachment for '${id}'`, cause); }
        }
      }
    }
    if (this.entityExtractor) {
      const current = await graph.neighbors({ nodeId: memoryNode.id, direction: "outbound", relation: "MENTIONS", limit: 1000, scope: this.scope });
      for (const stale of current) if (!desiredEntityIds.has(stale.targetId)) await graph.deleteEdge(stale.id, this.scope);
    }
    await checkpoint?.("knowledge_saved");
    return record;
  }

  private async searchMemories(input: MemorySearchInput): Promise<MemoryRecord[]> {
    const limit = Math.max(1, Math.min(input.limit ?? 20, 500));
    const filters = { ...input, limit, scope: this.scope };
    const lexical = await this.requireMemories("search").search(filters);
    if (!input.query?.trim() || !this.embeddingProvider || !this.resolve("vector", "search")) return lexical;
    const query = input.query;
    const embedding = await this.providerCall("EmbeddingProvider", "embed", () => this.embeddingProvider!.embed({ text: query }));
    const vectors = await this.requireVector("search").search({ embedding, namespace: "memory", model: this.embeddingProvider?.model, limit: Math.min(limit * 3, 500), scope: this.scope });
    const semantic: MemoryRecord[] = [];
    for (const candidate of vectors) {
      const record = await this.requireMemories("read").get(candidate.id, this.scope);
      if (record && (!input.agentId || record.agentId === input.agentId) && (!input.userId || record.userId === input.userId) && (!input.sessionId || record.sessionId === input.sessionId) && (!input.type || record.type === input.type)) semantic.push(record);
    }
    const merged = new Map<string, MemoryRecord>();
    for (const record of [...semantic, ...lexical]) if (!input.metadata || Object.entries(input.metadata).every(([key, value]) => record.metadata[key] === value)) merged.set(record.id, record);
    return [...merged.values()].slice(0, limit);
  }

  private async queryKnowledge(input: PlanetQueryInput): Promise<PlanetQueryResult[]> {
    if (!input.text.trim()) throw new PlanetValidationError("Query text cannot be empty.");
    const limit = Math.max(1, Math.min(input.limit ?? 20, 100000));
    const search = input.search ?? { keyword: true, vector: true, graph: true };
    const keywordPromise = search.keyword ? this.searchGraph({ query: input.text, limit: limit * 3 }) : Promise.resolve([]);
    const vectorPromise = search.vector ? this.searchGraph({ query: input.text, semantic: true, limit: limit * 3, graph: { depth: search.graph ? input.expand?.relationDepth ?? 1 : 0 }, asOf: input.asOf }) : Promise.resolve([]);
    const chunkKeywordPromise = search.keyword && this.resolve("chunks", "search") ? this.requireChunks("search").search({ query: input.text, limit: limit * 3, scope: this.scope }) : Promise.resolve([]);
    const chunkVectorPromise = search.vector && this.embeddingProvider && this.resolve("vector", "search") ? (async () => {
      const embedding = await this.providerCall("EmbeddingProvider", "embed", () => this.embeddingProvider!.embed({ text: input.text }));
      const matches = await this.requireVector("search").search({ embedding, namespace: "document-chunk", model: this.embeddingProvider!.model, limit: limit * 3, scope: this.scope });
      const records = [];
      for (const match of matches) { const chunk = await this.requireChunks("read").get(match.id, this.scope); if (chunk && (!input.filters?.documentId || chunk.documentId === input.filters.documentId)) records.push({ chunk, score: match.score }); }
      return records;
    })() : Promise.resolve([]);
    const [keyword, vector, chunkKeywords, chunkVectors] = await Promise.all([keywordPromise, vectorPromise, chunkKeywordPromise, chunkVectorPromise]);
    let graphResults: GraphSearchResult[] = [];
    if (search.graph && !search.vector && keyword.length) {
      const traversal = await this.requireGraph("search").traverse({ startIds: keyword.map((item) => item.node.id), depth: input.expand?.relationDepth ?? 1, limit: limit * 10, scope: this.scope, asOf: input.asOf });
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
    const results = [...fused.values()].sort((a, b) => b.score - a.score || a.node.name.localeCompare(b.node.name) || a.node.id.localeCompare(b.node.id)).slice(0, limit);
    if (input.includeEvidence === false) for (const result of results) result.evidence = [];
    if (input.filters?.agentId) {
      const allowed = new Set((await this.searchMemories({ agentId: input.filters.agentId, query: input.text, limit: limit * 3 })).map((memory) => memory.id));
      return results.filter((result) => result.node.type !== "memory" || allowed.has(result.node.id));
    }
    return results;
  }

  private async searchGraph(input: GraphSearchInput): Promise<GraphSearchResult[]> {
    const limit = input.limit ?? 20;
    if (!input.semantic) {
      const nodes = await this.requireGraph("search").searchNodes({ query: input.query, limit, scope: this.scope });
      return nodes.map((item) => ({ node: item, score: 1, evidence: [], edges: [] }));
    }
    if (!this.embeddingProvider) throw new PlanetCapabilityError("EmbeddingProvider");
    const embedding = await this.providerCall("EmbeddingProvider", "embed", () => this.embeddingProvider!.embed({ text: input.query }));
    const candidates = await this.requireVector("search").search({
      embedding,
      namespace: input.vectorNamespace ?? this.retrieval.nodeNamespace ?? "node",
      model: this.embeddingProvider.model,
      limit: input.candidateLimit ?? this.retrieval.candidateLimit ?? Math.max(limit, limit * 2),
      scope: this.scope,
    });
    return this.expandAndRank(candidates, input.graph?.depth ?? this.retrieval.defaultGraphDepth ?? 0, limit, input.query, input.asOf);
  }

  private async expandAndRank(candidates: VectorSearchResult[], depth: number, limit: number, query: string, asOf?: Date): Promise<GraphSearchResult[]> {
    if (candidates.length === 0) return [];
    const candidateScores = new Map(candidates.map((candidate) => [candidate.id, candidate.score]));
    const traversal: GraphTraversal = await this.requireGraph("search").traverse({ startIds: candidates.map((candidate) => candidate.id), depth, limit: limit * 10, scope: this.scope, asOf });
    const evidenceStore = this.resolve("evidence", "read");
    const evidence = evidenceStore && traversal.edges.length > 0
      ? await evidenceStore.list({ edgeIds: traversal.edges.map((item) => item.id), limit: limit * 20, scope: this.scope }) : [];
    const evidenceByEdge = new Map<string, Evidence[]>();
    for (const item of evidence) evidenceByEdge.set(item.edgeId, [...(evidenceByEdge.get(item.edgeId) ?? []), item]);
    const results = traversal.nodes.map((item) => {
      const nodeDepth = traversal.depthByNode[item.id] ?? 0;
      const direct = candidateScores.get(item.id) ?? 0;
      const score = direct > 0 ? direct : Math.max(...candidates.map((candidate) => candidate.score * Math.pow(this.retrieval.graphDecay ?? 0.8, nodeDepth)));
      const edges = traversal.edges.filter((edge) => edge.sourceId === item.id || edge.targetId === item.id);
      return { node: item, score, edges, evidence: edges.flatMap((edge) => evidenceByEdge.get(edge.id) ?? []) };
    }).sort((left, right) => right.score - left.score || left.node.name.localeCompare(right.node.name) || left.node.id.localeCompare(right.node.id));
    const ranked = this.retrieval.ranker ? await this.retrieval.ranker({ query, results }) : results;
    return ranked.slice(0, limit);
  }
}
