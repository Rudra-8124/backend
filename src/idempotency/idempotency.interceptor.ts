import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  BadRequestException,
  Optional,
} from '@nestjs/common';
import { Observable, of } from 'rxjs';
import { tap, catchError } from 'rxjs/operators';
import { FastifyReply, FastifyRequest } from 'fastify';
import { IdempotencyService } from './idempotency.service';
import { MetricsService } from '../common/observability/metrics.service';

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly idempotencyService: IdempotencyService,
    @Optional()
    private readonly metricsService?: MetricsService,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const http = context.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();

    const method = request.method.toUpperCase();
    const isStateChanging = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);

    const rawKey = request.headers['idempotency-key'] || request.headers['Idempotency-Key'];
    const idempotencyKey = Array.isArray(rawKey) ? rawKey[0] : rawKey;

    // If not a state-changing method or no idempotency key provided, proceed normally
    if (!isStateChanging || !idempotencyKey) {
      return next.handle();
    }

    if (typeof idempotencyKey !== 'string' || idempotencyKey.trim().length === 0) {
      throw new BadRequestException('Idempotency-Key header must be a non-empty string');
    }

    const user = (request as unknown as Record<string, unknown>).user as
      { userId?: string } | undefined;
    const userId = user?.userId || request.ip || 'anonymous';
    const endpoint = `${method}:${(request.routeOptions?.url || request.url).split('?')[0]}`;
    const requestHash = this.idempotencyService.hashPayload(request.body);

    const claim = await this.idempotencyService.claimKey({
      userId,
      endpoint,
      idempotencyKey: idempotencyKey.trim(),
      requestHash,
    });

    if (claim.status === 'COMPLETED') {
      this.metricsService?.recordIdempotencyReplay();
      void reply
        .status(claim.responseStatus || 200)
        .header('idempotency-replay', 'true')
        .header('idempotency-key', idempotencyKey);
      return of(claim.responseBody);
    }

    return next.handle().pipe(
      tap({
        next: async (response) => {
          if (claim.keyId) {
            const statusCode = reply.statusCode || 200;
            await this.idempotencyService.completeKey(
              claim.keyId,
              statusCode,
              response as Record<string, unknown>,
            );
          }
        },
      }),
      catchError(async (err) => {
        // On error during handler execution, release the in-progress lock so client can retry
        if (claim.keyId) {
          await this.idempotencyService.releaseKey(claim.keyId);
        }
        throw err;
      }),
    );
  }
}
