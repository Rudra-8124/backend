import { ServiceUnavailableException } from '@nestjs/common';

export enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  resetTimeoutMs?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  maxRetries?: number;
}

export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount: number = 0;
  private lastFailureTime: number = 0;

  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly maxRetries: number;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 3;
    this.resetTimeoutMs = options.resetTimeoutMs ?? 5000;
    this.baseBackoffMs = options.baseBackoffMs ?? 50;
    this.maxBackoffMs = options.maxBackoffMs ?? 1000;
    this.maxRetries = options.maxRetries ?? 2;
  }

  public getState(): CircuitState {
    if (this.state === CircuitState.OPEN) {
      const now = Date.now();
      if (now - this.lastFailureTime >= this.resetTimeoutMs) {
        this.state = CircuitState.HALF_OPEN;
      }
    }
    return this.state;
  }

  public async execute<T>(fn: () => Promise<T>): Promise<T> {
    const currentState = this.getState();

    if (currentState === CircuitState.OPEN) {
      throw new ServiceUnavailableException(
        'Payment provider circuit breaker is OPEN (provider unavailable). Fast-failing request.',
      );
    }

    let lastError: Error | unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const result = await fn();
        this.onSuccess();
        return result;
      } catch (err) {
        lastError = err;
        // If circuit became OPEN during previous attempt, stop retrying
        if (this.state === CircuitState.OPEN) {
          break;
        }

        if (attempt < this.maxRetries) {
          // Exponential backoff with full jitter
          const maxWait = Math.min(this.maxBackoffMs, this.baseBackoffMs * Math.pow(2, attempt));
          const jitter = Math.floor(Math.random() * maxWait);
          await this.sleep(jitter);
        }
      }
    }

    this.onFailure();
    throw lastError;
  }

  private onSuccess(): void {
    this.failureCount = 0;
    this.state = CircuitState.CLOSED;
  }

  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.state === CircuitState.HALF_OPEN || this.failureCount >= this.failureThreshold) {
      this.state = CircuitState.OPEN;
    }
  }

  public reset(): void {
    this.state = CircuitState.CLOSED;
    this.failureCount = 0;
    this.lastFailureTime = 0;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
