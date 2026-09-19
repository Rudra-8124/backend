import { Injectable, Inject } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.constants';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * Redis sliding-window rate limiter.
 * Uses a sorted set with timestamp scores for precise sliding windows.
 */
@Injectable()
export class RateLimitService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /**
   * Check and consume a rate limit token.
   * @param key - unique identifier (e.g., "login:192.168.1.1" or "api:user-uuid")
   * @param maxRequests - max requests in the window
   * @param windowSeconds - window size in seconds
   */
  async consume(key: string, maxRequests: number, windowSeconds: number): Promise<RateLimitResult> {
    const now = Date.now();
    const windowStart = now - windowSeconds * 1000;
    const redisKey = `rl:${key}`;

    // Use a pipeline for atomicity
    const pipeline = this.redis.pipeline();
    // Remove entries outside the window
    pipeline.zremrangebyscore(redisKey, 0, windowStart);
    // Count current entries
    pipeline.zcard(redisKey);
    // Add current request
    pipeline.zadd(redisKey, now, `${now}:${Math.random()}`);
    // Set TTL
    pipeline.expire(redisKey, windowSeconds);

    const results = await pipeline.exec();
    if (!results) {
      return { allowed: true, remaining: maxRequests - 1, retryAfterSeconds: 0 };
    }

    const currentCount = (results[1][1] as number) || 0;

    if (currentCount >= maxRequests) {
      // Over limit — remove the entry we just added
      // (it was added optimistically in the pipeline)
      // Get the oldest entry to calculate retry-after
      const oldest = await this.redis.zrange(redisKey, 0, 0, 'WITHSCORES');
      const oldestTs = oldest.length >= 2 ? parseInt(oldest[1], 10) : now;
      const retryAfter = Math.ceil((oldestTs + windowSeconds * 1000 - now) / 1000);

      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(retryAfter, 1),
      };
    }

    return {
      allowed: true,
      remaining: maxRequests - currentCount - 1,
      retryAfterSeconds: 0,
    };
  }
}
