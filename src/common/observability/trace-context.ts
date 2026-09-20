import {
  context,
  propagation,
  trace,
  Span,
  SpanStatusCode,
  SpanKind,
  Context,
  ROOT_CONTEXT,
} from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { randomBytes } from 'crypto';

let providerInitialized = false;

/**
 * Ensures a TracerProvider is registered so propagation functions are active.
 */
export function ensureTracerProvider(): void {
  if (providerInitialized) return;
  try {
    const provider = new NodeTracerProvider();
    provider.register();
    providerInitialized = true;
  } catch {
    providerInitialized = true;
  }
}

/**
 * Generates a valid W3C traceparent string ('00-{16-bytes-hex}-{8-bytes-hex}-01').
 */
export function generateTraceparent(): string {
  const traceId = randomBytes(16).toString('hex');
  const spanId = randomBytes(8).toString('hex');
  return `00-${traceId}-${spanId}-01`;
}

/**
 * Returns the active W3C traceparent string ('00-traceid-spanid-traceflags')
 * if a valid span context is active, or undefined otherwise.
 */
export function getActiveTraceparent(): string | undefined {
  ensureTracerProvider();
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  if (carrier['traceparent']) {
    return carrier['traceparent'];
  }

  // Fallback: check active span directly
  const span = trace.getSpan(context.active());
  if (span) {
    const sc = span.spanContext();
    if (sc && sc.traceId && sc.traceId !== '00000000000000000000000000000000') {
      const traceFlags = (sc.traceFlags || 1).toString(16).padStart(2, '0');
      return `00-${sc.traceId}-${sc.spanId}-${traceFlags}`;
    }
  }

  return undefined;
}

/**
 * Extracts a Context from a W3C traceparent string.
 * If traceparent is missing or invalid, returns the root context.
 */
export function extractContextFromTraceparent(traceparent?: string): Context {
  ensureTracerProvider();
  if (!traceparent) {
    return context.active();
  }
  return propagation.extract(ROOT_CONTEXT, { traceparent });
}

/**
 * Returns the current trace ID (32 hex characters) if available.
 */
export function getCurrentTraceId(): string | undefined {
  const span = trace.getSpan(context.active());
  if (span) {
    const sc = span.spanContext();
    if (sc && sc.traceId && sc.traceId !== '00000000000000000000000000000000') {
      return sc.traceId;
    }
  }
  return undefined;
}

/**
 * Returns the current span ID (16 hex characters) if available.
 */
export function getCurrentSpanId(): string | undefined {
  const span = trace.getSpan(context.active());
  if (span) {
    const sc = span.spanContext();
    if (sc && sc.spanId && sc.spanId !== '0000000000000000') {
      return sc.spanId;
    }
  }
  return undefined;
}

/**
 * Executes a function inside an active manual span.
 */
export async function withActiveSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  options?: {
    attributes?: Record<string, string | number | boolean>;
    kind?: SpanKind;
    tracerName?: string;
  },
): Promise<T> {
  const tracer = trace.getTracer(options?.tracerName || 'amrutam-telemedicine');
  return tracer.startActiveSpan(
    name,
    {
      attributes: options?.attributes,
      kind: options?.kind || SpanKind.INTERNAL,
    },
    async (span) => {
      try {
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err: unknown) {
        if (err instanceof Error) {
          span.recordException(err);
          span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
        } else {
          span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
        }
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

/**
 * Executes a function inside a context extracted from a traceparent.
 */
export async function withTraceparentContext<T>(
  traceparent: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const ctx = extractContextFromTraceparent(traceparent);
  return context.with(ctx, fn);
}
