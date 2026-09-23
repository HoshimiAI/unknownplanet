import { context, isSpanContextValid, metrics, SpanStatusCode, trace, type Attributes, type SpanContext } from "@opentelemetry/api";

const tracer = trace.getTracer("@unknown-planet/sdk", "0.1.0");
const meter = metrics.getMeter("@unknown-planet/sdk", "0.1.0");
const operationCount = meter.createCounter("unknownplanet.operations", { description: "Unknown Planet SDK operations" });
const operationDuration = meter.createHistogram("unknownplanet.operation.duration", { unit: "ms", description: "Unknown Planet SDK operation duration" });
const providerCallCount = meter.createCounter("unknownplanet.provider.calls", { description: "Calls to embedding, extraction, and parser providers" });
const providerCallDuration = meter.createHistogram("unknownplanet.provider.duration", { unit: "ms", description: "Provider call duration" });
const tokenUsage = meter.createCounter("gen_ai.client.token.usage", { unit: "{token}", description: "Tokens reported by model providers" });
const httpRequests = meter.createCounter("http.server.request.count", { description: "HTTP requests handled by Unknown Planet" });
const httpDuration = meter.createHistogram("http.server.request.duration", { unit: "ms", description: "HTTP server request duration" });

export function startHttpRequest(input: { method: string; requestId: string }) {
  const started = performance.now();
  const span = tracer.startSpan("http.server.request", { attributes: { "http.request.method": input.method, "http.request_id": input.requestId } });
  const ids = span.spanContext();
  const spanContext = isSpanContextValid(ids) ? ids : undefined;
  return {
    traceId: spanContext?.traceId,
    spanId: spanContext?.spanId,
    spanContext,
    finish(status: number, error?: unknown) {
      const attributes = { "http.request.method": input.method, "http.response.status_code": status };
      if (error !== undefined) {
        span.recordException(error instanceof Error ? error : new Error("Unknown request failure"));
        span.setStatus({ code: SpanStatusCode.ERROR });
      }
      httpRequests.add(1, attributes);
      httpDuration.record(performance.now() - started, attributes);
      span.setAttribute("http.response.status_code", status);
      span.end();
    },
  };
}

export async function withSpan<T>(name: string, attributes: Attributes, operation: () => Promise<T>, parent?: SpanContext): Promise<T> {
  const started = performance.now();
  const labels = { "unknownplanet.operation": name, ...attributes };
  const record = async (span: import("@opentelemetry/api").Span) => {
    try {
      const result = await operation();
      operationCount.add(1, { ...labels, "outcome": "success" });
      return result;
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error("Unknown failure"));
      span.setStatus({ code: SpanStatusCode.ERROR });
      operationCount.add(1, { ...labels, "outcome": "error" });
      throw error;
    } finally {
      const duration = performance.now() - started;
      operationDuration.record(duration, labels);
      span.end();
    }
  };
  return parent
    ? tracer.startActiveSpan(name, { attributes: labels }, trace.setSpanContext(context.active(), parent), record)
    : tracer.startActiveSpan(name, { attributes: labels }, record);
}

export async function withProviderSpan<T>(capability: string, method: string, operation: () => Promise<T>, model?: string): Promise<T> {
  const started = performance.now();
  const attributes: Attributes = { "unknownplanet.provider.capability": capability, "unknownplanet.provider.method": method, ...(model ? { "gen_ai.request.model": model } : {}) };
  return tracer.startActiveSpan(`provider.${capability}.${method}`, { attributes }, async (span) => {
    try {
      const result = await operation();
      providerCallCount.add(1, { ...attributes, outcome: "success" });
      return result;
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error("Unknown failure"));
      span.setStatus({ code: SpanStatusCode.ERROR });
      providerCallCount.add(1, { ...attributes, outcome: "error" });
      throw error;
    } finally {
      providerCallDuration.record(performance.now() - started, attributes);
      span.end();
    }
  });
}

export function recordModelTokenUsage(input: { provider: string; model: string; inputTokens?: number; outputTokens?: number }): void {
  const common = { "gen_ai.provider.name": input.provider, "gen_ai.request.model": input.model };
  if (Number.isFinite(input.inputTokens) && (input.inputTokens ?? 0) >= 0) tokenUsage.add(input.inputTokens!, { ...common, "gen_ai.token.type": "input" });
  if (Number.isFinite(input.outputTokens) && (input.outputTokens ?? 0) >= 0) tokenUsage.add(input.outputTokens!, { ...common, "gen_ai.token.type": "output" });
}
