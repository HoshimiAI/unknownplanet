import type { EmbeddingProvider, EntityExtractor, ExtractedEntity } from "@unknown-planet/core";
import { recordModelTokenUsage } from "../observability/telemetry.js";

export interface OpenAICompatibleEmbeddingConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
  dimensions?: number;
  timeoutMs?: number;
  maxRetries?: number;
}

async function postJson(url: string, apiKey: string, body: unknown, timeoutMs: number, maxRetries: number): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: controller.signal });
      if (!response.ok) {
        const error = new Error(`Provider request failed with HTTP ${response.status}.`);
        if (attempt < maxRetries && (response.status === 429 || response.status >= 500)) { lastError = error; await new Promise((resolve) => setTimeout(resolve, Math.min(250 * 2 ** attempt, 2000))); continue; }
        throw error;
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt === maxRetries || (error instanceof Error && error.message.startsWith("Provider request failed with HTTP "))) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(250 * 2 ** attempt, 2000)));
    } finally { clearTimeout(timer); }
  }
  throw lastError;
}

/** OpenAI API and OpenAI-compatible local gateways share this small embedding adapter. */
export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  constructor(private readonly config: OpenAICompatibleEmbeddingConfig) {
    if (!config.apiKey.trim() || !config.model.trim()) throw new Error("Embedding provider requires an API key and model.");
    this.model = config.model;
  }
  async embed(input: { text: string }): Promise<number[]> {
    const response = await postJson(`${(this.config.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "")}/embeddings`, this.config.apiKey, { model: this.model, input: input.text, ...(this.config.dimensions ? { dimensions: this.config.dimensions } : {}) }, this.config.timeoutMs ?? 15000, this.config.maxRetries ?? 2) as { data?: Array<{ embedding?: number[] }>; usage?: { prompt_tokens?: number; total_tokens?: number } };
    recordModelTokenUsage({ provider: "openai_compatible", model: this.model, inputTokens: response.usage?.prompt_tokens });
    const vector = response.data?.[0]?.embedding;
    if (!vector?.length || vector.some((value) => !Number.isFinite(value))) throw new Error("Embedding provider returned an invalid vector.");
    if (this.config.dimensions && vector.length !== this.config.dimensions) throw new Error(`Embedding provider returned ${vector.length} dimensions; expected ${this.config.dimensions}.`);
    return vector;
  }
}

export interface JsonHttpEntityExtractorConfig { apiKey: string; endpoint: string; model: string; timeoutMs?: number; maxRetries?: number }

/** Expects a provider endpoint to return { entities: [{ name, type, aliases? }] } or an OpenAI chat JSON response. */
export class JsonHttpEntityExtractor implements EntityExtractor {
  constructor(private readonly config: JsonHttpEntityExtractorConfig) {
    if (!config.apiKey.trim() || !config.endpoint.trim() || !config.model.trim()) throw new Error("Entity extractor requires an API key, endpoint, and model.");
  }
  async extract(input: { text: string }): Promise<ExtractedEntity[]> {
    const body = { model: this.config.model, response_format: { type: "json_object" }, messages: [{ role: "system", content: "Extract named entities from the text. Return JSON with an entities array. Each entity has name, type, and optional aliases." }, { role: "user", content: input.text }] };
    const response = await postJson(this.config.endpoint, this.config.apiKey, body, this.config.timeoutMs ?? 20000, this.config.maxRetries ?? 2) as { entities?: unknown; choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number; input_tokens?: number; output_tokens?: number } };
    recordModelTokenUsage({ provider: "openai_compatible", model: this.config.model, inputTokens: response.usage?.prompt_tokens ?? response.usage?.input_tokens, outputTokens: response.usage?.completion_tokens ?? response.usage?.output_tokens });
    let payload: unknown = response;
    if (response.choices?.[0]?.message?.content) {
      try { payload = JSON.parse(response.choices[0].message.content); }
      catch { throw new Error("Entity extractor returned malformed JSON."); }
    }
    if (!payload || typeof payload !== "object" || !Array.isArray((payload as { entities?: unknown }).entities)) throw new Error("Entity extractor response must include an entities array.");
    return (payload as { entities: ExtractedEntity[] }).entities;
  }
}
