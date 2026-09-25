import type { EmbeddingProvider, VectorCollectionConfig } from "@unknown-planet/core";
import { EmbeddingDimensionMismatchError } from "@unknown-planet/core";
import { EmbeddingModelMismatchError, PlanetEmbeddingNotConfiguredError, PlanetValidationError } from "../errors.js";

/** Centralizes provider calls, batching, and vector-collection compatibility checks. */
export class EmbeddingService {
  constructor(
    private readonly provider: EmbeddingProvider | undefined,
    private readonly collections: Readonly<Record<string, VectorCollectionConfig>>,
  ) {
    for (const [name, config] of Object.entries(collections)) {
      if (!Number.isInteger(config.dimensions) || config.dimensions < 1) throw new PlanetValidationError(`Vector collection '${name}' dimensions must be a positive integer.`);
      if (provider?.dimensions !== undefined && provider.dimensions !== config.dimensions) {
        throw new EmbeddingDimensionMismatchError(config.dimensions, provider.dimensions, provider.model ?? "unspecified", name);
      }
      if (config.model && provider?.model && config.model !== provider.model) {
        throw new EmbeddingModelMismatchError(config.model, provider.model, name);
      }
    }
  }

  validate(vector: number[], collection?: string, model?: string): void {
    if (!Array.isArray(vector) || vector.length === 0 || vector.some((value) => !Number.isFinite(value))) {
      throw new PlanetValidationError("Embedding provider returned an invalid embedding.");
    }
    const config = collection ? this.collections[collection] : undefined;
    const expectedDimensions = config?.dimensions ?? this.provider?.dimensions;
    if (expectedDimensions !== undefined && vector.length !== expectedDimensions) {
      throw new EmbeddingDimensionMismatchError(expectedDimensions, vector.length, model ?? this.provider?.model ?? "unspecified", collection ?? "unspecified");
    }
    if (config?.model && model && config.model !== model) throw new EmbeddingModelMismatchError(config.model, model, collection!);
  }

  async embed(text: string, collections: readonly string[] = []): Promise<number[]> {
    if (!this.provider) throw new PlanetEmbeddingNotConfiguredError();
    const vector = await this.provider.embed({ text });
    this.validate(vector, collections[0], this.provider.model);
    for (const collection of collections.slice(1)) this.validate(vector, collection, this.provider.model);
    return vector;
  }

  async embedMany(texts: string[], collection?: string): Promise<number[][]> {
    if (!this.provider) throw new PlanetEmbeddingNotConfiguredError();
    if (texts.length === 0) return [];
    const vectors = this.provider.embedMany
      ? await this.provider.embedMany(texts)
      : await Promise.all(texts.map((text) => this.provider!.embed({ text })));
    if (!Array.isArray(vectors) || vectors.length !== texts.length) throw new PlanetValidationError(`Embedding provider returned ${vectors?.length ?? 0} vectors for ${texts.length} inputs.`);
    for (const vector of vectors) this.validate(vector, collection, this.provider.model);
    return vectors;
  }
}
