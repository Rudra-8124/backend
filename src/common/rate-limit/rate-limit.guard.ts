import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RateLimitService } from './rate-limit.service';

export const RATE_LIMIT_KEY = 'rateLimit';

export interface RateLimitConfig {
  maxRequests: number;
  windowSeconds: number;
}

/** Rate limit tiers — matching api-endpoints.md */
export const RATE_LIMIT_TIERS = {
  strict: { maxRequests: 5, windowSeconds: 60 } as RateLimitConfig,
  auth: { maxRequests: 10, windowSeconds: 60 } as RateLimitConfig,
  standard: { maxRequests: 60, windowSeconds: 60 } as RateLimitConfig,
  relaxed: { maxRequests: 120, windowSeconds: 60 } as RateLimitConfig,
};

/** Decorator to apply a rate-limit tier to a route. */
export const RateLimit = (tier: keyof typeof RATE_LIMIT_TIERS) =>
  SetMetadata(RATE_LIMIT_KEY, RATE_LIMIT_TIERS[tier]);

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly rateLimitService: RateLimitService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const config = this.reflector.getAllAndOverride<RateLimitConfig | undefined>(RATE_LIMIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!config) return true; // no rate limit configured

    const request = context.switchToHttp().getRequest();
    const ip = request.ip || request.socket?.remoteAddress || 'unknown';
    const userId = request.user?.userId;

    // Use user ID if authenticated, otherwise IP
    const identifier = userId || ip;
    const key = `${request.method}:${request.routeOptions?.url || request.url}:${identifier}`;

    const result = await this.rateLimitService.consume(
      key,
      config.maxRequests,
      config.windowSeconds,
    );

    if (!result.allowed) {
      throw new HttpException(
        {
          type: 'https://httpstatuses.io/429',
          title: 'Too Many Requests',
          status: 429,
          detail: `Rate limit exceeded. Retry after ${result.retryAfterSeconds} seconds.`,
          retryAfter: result.retryAfterSeconds,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }
}
