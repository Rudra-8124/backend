import { Params } from 'nestjs-pino';
import { randomUUID } from 'crypto';
import { getCurrentTraceId, getCurrentSpanId } from '../observability/trace-context';

/** Pino logger configuration with PII/PHI redaction and OpenTelemetry trace correlation */
export function pinoLoggerConfig(): Params {
  return {
    pinoHttp: {
      level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
      transport:
        process.env.NODE_ENV !== 'production' && process.env.PINO_PRETTY === 'true'
          ? { target: 'pino-pretty', options: { colorize: true, singleLine: true } }
          : undefined,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.body.password',
          'req.body.refresh_token',
          'req.body.refreshToken',
          'req.body.totp_code',
          'req.body.totpCode',
          'req.body.recovery_code',
          'req.body.recoveryCode',
          'req.body.mfa_secret',
          'res.headers["set-cookie"]',
          'req.body.email',
          'req.body.notes',
          'req.body.diagnosis',
          'req.body.medications',
        ],
        censor: '[REDACTED]',
      },
      genReqId: (req: any) =>
        (req.headers ? (req.headers['x-request-id'] as string) : undefined) || randomUUID(),
      customProps: (_req: any, _res: any) => {
        const traceId = getCurrentTraceId();
        const spanId = getCurrentSpanId();
        return {
          ...(traceId ? { trace_id: traceId } : {}),
          ...(spanId ? { span_id: spanId } : {}),
        };
      },
      formatters: {
        log: (object: Record<string, any>) => {
          const traceId = getCurrentTraceId();
          const spanId = getCurrentSpanId();
          if (traceId && !object.trace_id) {
            object.trace_id = traceId;
          }
          if (spanId && !object.span_id) {
            object.span_id = spanId;
          }
          return object;
        },
      },
      serializers: {
        req: (req: any) => ({
          method: req.method,
          url: req.url,
          remoteAddress: req.remoteAddress || req.ip,
        }),
        res: (res: any) => ({
          statusCode: res.statusCode,
        }),
      },
    },
  };
}
