import { NodeSDK } from '@opentelemetry/sdk-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';

let sdkInstance: NodeSDK | null = null;

export function initTracing(
  serviceName: string = process.env.OTEL_SERVICE_NAME || 'amrutam-api',
): NodeSDK | null {
  if (process.env.OTEL_SDK_DISABLED === 'true') {
    return null;
  }

  if (sdkInstance) {
    return sdkInstance;
  }

  if (process.env.OTEL_LOG_LEVEL === 'debug') {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
  }

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318/v1/traces';

  const traceExporter = new OTLPTraceExporter({
    url: endpoint,
    headers: {},
  });

  sdkInstance = new NodeSDK({
    resource: resourceFromAttributes({
      'service.name': serviceName,
      'service.version': '0.1.0',
      'deployment.environment': process.env.NODE_ENV || 'development',
    }),
    traceExporter,
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (req) => {
          // Ignore health checks and prometheus scrapes from trace pollution
          const url = req.url || '';
          return (
            url.startsWith('/healthz') || url.startsWith('/readyz') || url.startsWith('/metrics')
          );
        },
      }),
      new PgInstrumentation({
        enhancedDatabaseReporting: true,
      }),
      new IORedisInstrumentation(),
    ],
  });

  try {
    sdkInstance.start();
  } catch (err) {
    console.error('Failed to start OpenTelemetry SDK:', err);
  }

  process.on('SIGTERM', async () => {
    try {
      await sdkInstance?.shutdown();
    } catch (err) {
      console.error('Error shutting down OpenTelemetry SDK:', err);
    }
  });

  return sdkInstance;
}
