import type {
  AddEvidenceInput, BlobStorageAdapter, CreateDocumentInput, CreateEdgeInput, CreateNodeInput,
  DataLayerProvider, DocumentStore, EmbeddingProvider, Evidence, EvidenceStore, GraphEdge, GraphNode,
  GraphStore, GraphTraversal, ProviderRouting, SqlStore, SqlTransaction, VectorSearchResult, VectorStore,
} from "@unknown-planet/core";

export type { BlobStorageAdapter, DataLayerProvider, DocumentStore, EmbeddingProvider, EvidenceStore, GraphStore, ProviderRouting, SqlStore, SqlTransaction, VectorStore } from "@unknown-planet/core";

/** A typed key for an application-defined provider extension. */
export interface PlanetExtension<T> { readonly key: string; readonly __type?: T }
export function definePlanetExtension<T>(key: string): PlanetExtension<T> {
  if (!key.trim()) throw new Error("Planet extension keys cannot be empty.");
  return Object.freeze({ key });
}

type ProviderCapability = "graph" | "vector" | "documents" | "evidence" | "blobs" | "sql";
export interface ProviderSelectionInput {
  capability: ProviderCapability;
  providers: readonly DataLayerProvider[];
}
/** Selects a provider when no explicit routing rule exists. */
export type ProviderSelector = (input: ProviderSelectionInput) => string | undefined;

export interface RetrievalConfig {
  /** Namespace containing graph-node vectors. Defaults to `node`. */
  nodeNamespace?: string;
  /** Default graph expansion depth for semantic search. Defaults to 0. */
  defaultGraphDepth?: number;
  /** Multiplier applied once per graph hop when scoring expanded nodes. Defaults to 0.8. */
  graphDecay?: number;
  /** Number of semantic candidates requested before graph expansion. */
  candidateLimit?: number;
  /** Optional application policy run after deterministic retrieval and before the result limit. */
  ranker?: (input: { query: string; results: GraphSearchResult[] }) => GraphSearchResult[] | Promise<GraphSearchResult[]>;
}

export interface PlanetConfig {
  /** Named providers. Each may implement any subset of the data capabilities. */
  providers?: DataLayerProvider[];
  /** Selects a provider for each capability; unspecified capabilities use the first matching provider. */
  routing?: ProviderRouting;
  /** Custom default provider selection; explicit `routing` always wins. */
  selectProvider?: ProviderSelector;
  /** Direct adapters remain supported for a single-provider setup. */
  graph?: GraphStore;
  vector?: VectorStore;
  documents?: DocumentStore;
  evidence?: EvidenceStore;
  blobs?: BlobStorageAdapter;
  sql?: SqlStore;
  /** Application- or package-defined capabilities for the inline provider. */
  extensions?: Record<string, unknown>;
  embeddings?: EmbeddingProvider;
  retrieval?: RetrievalConfig;
}

export interface GraphSearchInput {
  query: string;
  semantic?: boolean;
  limit?: number;
  graph?: { depth?: number };
  /** Override the configured vector namespace for this query. */
  vectorNamespace?: string;
  /** Override the configured semantic candidate budget for this query. */
  candidateLimit?: number;
}
export interface GraphSearchResult {
  node: GraphNode;
  score: number;
  evidence: Evidence[];
  edges: GraphEdge[];
}

/**
 * Storage-neutral application client. It provides deterministic graph and retrieval primitives;
 * it does not invoke an LLM or expose a database query language.
 */
export class Planet {
  private readonly providers: DataLayerProvider[];
  private readonly graphStore?: GraphStore;
  private readonly vectorStore?: VectorStore;
  private readonly documentStore?: DocumentStore;
  private readonly evidenceStore?: EvidenceStore;
  private readonly blobStorage?: BlobStorageAdapter;
  private readonly sqlStore?: SqlStore;
  private readonly embeddingProvider?: EmbeddingProvider;
  private readonly providerSelector?: ProviderSelector;
  private readonly retrieval: RetrievalConfig;
  private readonly extensionRoutes: Readonly<Record<string, string>>;

  constructor(config: PlanetConfig) {
    const inline: DataLayerProvider = {
      id: "inline",
      graph: config.graph,
      vector: config.vector,
      documents: config.documents,
      evidence: config.evidence,
      blobs: config.blobs,
      sql: config.sql,
      extensions: config.extensions,
    };
    this.providers = [inline, ...(config.providers ?? [])].filter((provider) =>
      provider.graph || provider.vector || provider.documents || provider.evidence || provider.blobs || provider.sql || Object.keys(provider.extensions ?? {}).length > 0,
    );
    const ids = new Set<string>();
    for (const provider of this.providers) {
      if (ids.has(provider.id)) throw new Error(`Duplicate Unknown Planet provider id: ${provider.id}`);
      ids.add(provider.id);
    }
    this.providerSelector = config.selectProvider;
    this.retrieval = config.retrieval ?? {};
    this.extensionRoutes = config.routing?.extensions ?? {};
    if (this.retrieval.graphDecay !== undefined && (this.retrieval.graphDecay < 0 || this.retrieval.graphDecay > 1)) {
      throw new Error("retrieval.graphDecay must be between 0 and 1.");
    }
    this.graphStore = this.resolve("graph", config.routing?.graph);
    this.vectorStore = this.resolve("vector", config.routing?.vector);
    this.documentStore = this.resolve("documents", config.routing?.documents);
    this.evidenceStore = this.resolve("evidence", config.routing?.evidence);
    this.blobStorage = this.resolve("blobs", config.routing?.blobs);
    this.sqlStore = this.resolve("sql", config.routing?.sql);
    this.embeddingProvider = config.embeddings;
  }

  readonly graph = {
    node: {
      create: (input: CreateNodeInput) => this.requireGraph().createNode(input),
      get: (id: string) => this.requireGraph().getNode(id),
      update: (id: string, input: Parameters<GraphStore["updateNode"]>[1]) => this.requireGraph().updateNode(id, input),
      delete: (id: string) => this.requireGraph().deleteNode(id),
    },
    edge: {
      create: (input: CreateEdgeInput) => this.requireGraph().createEdge(input),
      get: (id: string) => this.requireGraph().getEdge(id),
      delete: (id: string) => this.requireGraph().deleteEdge(id),
    },
    traverse: (input: Parameters<GraphStore["traverse"]>[0]) => this.requireGraph().traverse(input),
    search: (input: GraphSearchInput) => this.searchGraph(input),
  };

  readonly vector = {
    upsert: (input: Parameters<VectorStore["upsert"]>[0]) => this.requireVector().upsert(input),
    search: (input: Parameters<VectorStore["search"]>[0]) => this.requireVector().search(input),
    delete: (id: string) => this.requireVector().delete(id),
  };

  readonly document = {
    create: (input: CreateDocumentInput) => this.requireDocuments().create(input),
    get: (id: string) => this.requireDocuments().get(id),
  };

  readonly evidence = {
    add: (input: AddEvidenceInput) => this.requireEvidence().add(input),
    list: (input: Parameters<EvidenceStore["list"]>[0]) => this.requireEvidence().list(input),
  };

  readonly blob = {
    put: (input: Parameters<BlobStorageAdapter["put"]>[0]) => this.requireBlobs().put(input),
    get: (uri: string) => this.requireBlobs().get(uri),
    delete: (uri: string) => this.requireBlobs().delete(uri),
  };

  /** Execute parameterized SQL against the routed relational provider. */
  readonly sql = {
    query: <T extends Record<string, unknown> = Record<string, unknown>>(input: Parameters<SqlStore["query"]>[0]) => this.requireSql().query<T>(input),
    transaction: <T>(work: (transaction: SqlTransaction) => Promise<T>) => {
      const store = this.requireSql();
      if (!store.transaction) throw new Error("The routed SqlStore does not support transactions.");
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
    if (selectedId && !provider) throw new Error(`Unknown Planet provider '${selectedId}' is not registered.`);
    if (!provider || !Object.hasOwn(provider.extensions ?? {}, key)) {
      throw new Error(`No provider exposes the '${key}' extension.`);
    }
    return provider.extensions![key] as T;
  }

  /** Returns a client using the same providers with a different capability routing policy. */
  withRouting(routing: ProviderRouting): Planet {
    return new Planet({ providers: this.providers, routing, embeddings: this.embeddingProvider, selectProvider: this.providerSelector, retrieval: this.retrieval });
  }

  /** Returns a client with additional adapters. Existing provider ids remain protected from duplicates. */
  withProviders(providers: DataLayerProvider[], routing?: ProviderRouting): Planet {
    return new Planet({ providers: [...this.providers, ...providers], routing, embeddings: this.embeddingProvider, selectProvider: this.providerSelector, retrieval: this.retrieval });
  }

  private resolve<K extends ProviderCapability>(
    capability: K,
    providerId?: string,
  ): NonNullable<DataLayerProvider[K]> | undefined {
    const selectedId = providerId ?? this.providerSelector?.({ capability, providers: this.providers });
    const provider = selectedId ? this.providers.find((item) => item.id === selectedId) : this.providers.find((item) => item[capability]);
    if (selectedId && !provider) throw new Error(`Unknown Planet provider '${selectedId}' is not registered.`);
    if (selectedId && !provider?.[capability]) throw new Error(`Provider '${selectedId}' does not implement '${capability}'.`);
    return provider?.[capability] as NonNullable<DataLayerProvider[K]> | undefined;
  }

  private extensionRoute(key: string): string | undefined {
    // Routing is stored on construction through the extension provider selection below.
    return this.extensionRoutes[key];
  }

  private requireGraph(): GraphStore {
    if (!this.graphStore) throw new Error("Planet was created without a GraphStore provider.");
    return this.graphStore;
  }

  private requireVector(): VectorStore {
    if (!this.vectorStore) throw new Error("Planet was created without a VectorStore adapter.");
    return this.vectorStore;
  }
  private requireDocuments(): DocumentStore {
    if (!this.documentStore) throw new Error("Planet was created without a DocumentStore adapter.");
    return this.documentStore;
  }
  private requireEvidence(): EvidenceStore {
    if (!this.evidenceStore) throw new Error("Planet was created without an EvidenceStore adapter.");
    return this.evidenceStore;
  }
  private requireBlobs(): BlobStorageAdapter {
    if (!this.blobStorage) throw new Error("Planet was created without a BlobStorageAdapter provider.");
    return this.blobStorage;
  }
  private requireSql(): SqlStore {
    if (!this.sqlStore) throw new Error("Planet was created without a relational SqlStore provider.");
    return this.sqlStore;
  }

  private async searchGraph(input: GraphSearchInput): Promise<GraphSearchResult[]> {
    const limit = input.limit ?? 20;
    if (!input.semantic) {
      const nodes = await this.requireGraph().searchNodes({ query: input.query, limit });
      return nodes.map((item) => ({ node: item, score: 1, evidence: [], edges: [] }));
    }
    if (!this.embeddingProvider) throw new Error("Semantic graph search requires an EmbeddingProvider.");
    const embedding = await this.embeddingProvider.embed({ text: input.query });
    const candidates = await this.requireVector().search({
      embedding,
      namespace: input.vectorNamespace ?? this.retrieval.nodeNamespace ?? "node",
      limit: input.candidateLimit ?? this.retrieval.candidateLimit ?? Math.max(limit, limit * 2),
    });
    return this.expandAndRank(candidates, input.graph?.depth ?? this.retrieval.defaultGraphDepth ?? 0, limit, input.query);
  }

  private async expandAndRank(candidates: VectorSearchResult[], depth: number, limit: number, query: string): Promise<GraphSearchResult[]> {
    if (candidates.length === 0) return [];
    const candidateScores = new Map(candidates.map((candidate) => [candidate.id, candidate.score]));
    const traversal: GraphTraversal = await this.requireGraph().traverse({ startIds: candidates.map((candidate) => candidate.id), depth, limit: limit * 10 });
    const evidence = this.evidenceStore && traversal.edges.length > 0
      ? await this.evidenceStore.list({ edgeIds: traversal.edges.map((item) => item.id), limit: limit * 20 })
      : [];
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
