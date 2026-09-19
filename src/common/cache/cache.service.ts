import { Injectable, Inject, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { createHash, randomUUID } from 'crypto';
import { REDIS_CLIENT } from '../redis/redis.constants';

export interface CacheOptions<T> {
  namespace: string;
  identifier: string | Record<string, unknown>;
  ttlSeconds: number;
  jitterSeconds?: number;
  fetcher: () => Promise<T>;
}

@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /**
   * Get the current version for a given namespace.
   */
  async getNamespaceVersion(namespace: string): Promise<number> {
    try {
      const ver = await this.redis.get(`version:${namespace}`);
      return ver ? parseInt(ver, 10) : 0;
    } catch (err) {
      this.logger.warn(
        `Failed to get version for namespace ${namespace}: ${(err as Error).message}`,
      );
      return 0;
    }
  }

  /**
   * Invalidate a namespace by incrementing its version counter.
   * Zero key scanning required.
   */
  async invalidateNamespace(namespace: string): Promise<number> {
    try {
      const newVer = await this.redis.incr(`version:${namespace}`);
      this.logger.debug(`Invalidated namespace ${namespace} -> version ${newVer}`);
      return newVer;
    } catch (err) {
      this.logger.warn(`Failed to invalidate namespace ${namespace}: ${(err as Error).message}`);
      return 1;
    }
  }

  /**
   * Normalize an identifier or query parameters into a deterministic SHA-256 hash.
   */
  normalizeIdentifier(identifier: string | Record<string, unknown>): string {
    if (typeof identifier === 'string') {
      return identifier;
    }
    // Deterministic key sorting
    const sortedKeys = Object.keys(identifier).sort();
    const sortedObj: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      const val = identifier[key];
      if (val !== undefined && val !== null && val !== '') {
        sortedObj[key] = val;
      }
    }
    return createHash('sha256').update(JSON.stringify(sortedObj)).digest('hex');
  }

  /**
   * Cache-aside with stampede protection (single-flight lock) and TTL jitter.
   */
  async getOrSet<T>(options: CacheOptions<T>): Promise<{ data: T; cached: boolean }> {
    const { namespace, identifier, ttlSeconds, jitterSeconds = 30, fetcher } = options;
    const normalizedHash = this.normalizeIdentifier(identifier);
    const version = await this.getNamespaceVersion(namespace);
    const cacheKey = `${namespace}:v${version}:${normalizedHash}`;

    try {
      // 1. Check cache
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        return { data: JSON.parse(cached) as T, cached: true };
      }

      // 2. Stampede protection: single-flight distributed lock
      const lockKey = `lock:${cacheKey}`;
      const lockToken = randomUUID();
      const lockAcquired = await this.redis.set(lockKey, lockToken, 'PX', 5000, 'NX');

      if (lockAcquired === 'OK') {
        try {
          // Double check cache in case another worker populated it just now
          const doubleCheck = await this.redis.get(cacheKey);
          if (doubleCheck) {
            return { data: JSON.parse(doubleCheck) as T, cached: true };
          }

          // Fetch fresh data from DB
          const data = await fetcher();

          // Apply short TTL with random jitter
          const jitter = Math.floor(Math.random() * jitterSeconds);
          const finalTtl = ttlSeconds + jitter;
          await this.redis.set(cacheKey, JSON.stringify(data), 'EX', finalTtl);

          return { data, cached: false };
        } finally {
          // Release single-flight lock via Lua script
          const unlockScript = `
            if redis.call("get", KEYS[1]) == ARGV[1] then
              return redis.call("del", KEYS[1])
            else
              return 0
            end
          `;
          await this.redis.eval(unlockScript, 1, lockKey, lockToken).catch(() => {});
        }
      } else {
        // Another request is actively computing the result; poll for completion
        const maxWaitMs = 2500;
        const intervalMs = 50;
        const maxAttempts = maxWaitMs / intervalMs;

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, intervalMs));
          const lateCached = await this.redis.get(cacheKey);
          if (lateCached) {
            return { data: JSON.parse(lateCached) as T, cached: true };
          }
        }

        // Lock wait timed out; fall back to executing fetcher directly
        const data = await fetcher();
        return { data, cached: false };
      }
    } catch (err) {
      this.logger.warn(
        `Cache layer exception for ${cacheKey}, falling back to DB: ${(err as Error).message}`,
      );
      const data = await fetcher();
      return { data, cached: false };
    }
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const val = await this.redis.get(key);
      return val ? JSON.parse(val) : null;
    } catch {
      return null;
    }
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    try {
      await this.redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch (err) {
      this.logger.warn(`Failed to set cache key ${key}: ${(err as Error).message}`);
    }
  }

  async del(key: string): Promise<void> {
    try {
      await this.redis.del(key);
    } catch (err) {
      this.logger.warn(`Failed to delete cache key ${key}: ${(err as Error).message}`);
    }
  }
}
