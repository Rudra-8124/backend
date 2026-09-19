import { Params } from 'nestjs-pino';
import { randomUUID } from 'crypto';

/** Pino logger configuration with PII/PHI redaction */
export function pinoLoggerConfig(): Params {
  return {
    pinoHttp: {
      level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
      transport:
        process.env.NODE_ENV !== 'production'
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
        ],
        censor: '[REDACTED]',
      },
      genReqId: (req: any) =>
        (req.headers ? (req.headers['x-request-id'] as string) : undefined) || randomUUID(),
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
