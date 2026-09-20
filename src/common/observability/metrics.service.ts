import { Injectable, OnModuleInit } from '@nestjs/common';
import { Registry, collectDefaultMetrics, Counter, Histogram, Gauge } from 'prom-client';

@Injectable()
export class MetricsService implements OnModuleInit {
  private readonly registry: Registry;

  // 1. HTTP Metrics (RED per route)
  public readonly httpRequestDuration: Histogram<string>;
  public readonly httpRequestsTotal: Counter<string>;

  // 2. Booking & Concurrency Metrics
  public readonly bookingAttemptsTotal: Counter<string>;
  public readonly slotConflictsTotal: Counter<string>;
  public readonly idempotencyReplaysTotal: Counter<string>;

  // 3. Queue & Outbox Health Metrics
  public readonly outboxLagSeconds: Gauge<string>;
  public readonly queueDepth: Gauge<string>;
  public readonly outboxPendingTotal: Gauge<string>;
  public readonly outboxDlqTotal: Gauge<string>;

  // 4. Payment Provider & Resilience Metrics
  public readonly paymentProviderErrorsTotal: Counter<string>;
  public readonly circuitBreakerState: Gauge<string>;

  // 5. Database Pool Metrics
  public readonly dbPoolConnections: Gauge<string>;

  constructor() {
    this.registry = new Registry();

    // Default Node.js process / GC / memory metrics
    collectDefaultMetrics({ register: this.registry, prefix: 'amrutam_' });

    // HTTP request duration histogram (labeled by route template)
    this.httpRequestDuration = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request duration in seconds partitioned by method, route template, and status code',
      labelNames: ['method', 'route', 'status_code'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [this.registry],
    });

    // HTTP requests total counter
    this.httpRequestsTotal = new Counter({
      name: 'http_requests_total',
      help: 'Total number of HTTP requests processed',
      labelNames: ['method', 'route', 'status_code'],
      registers: [this.registry],
    });

    // Booking attempts total counter
    this.bookingAttemptsTotal = new Counter({
      name: 'booking_attempts_total',
      help: 'Total consultation booking attempts labeled by outcome result',
      labelNames: ['result'], // 'success' | 'conflict' | 'validation_error' | 'error'
      registers: [this.registry],
    });

    // Slot conflicts counter (409 concurrency lock contention)
    this.slotConflictsTotal = new Counter({
      name: 'slot_conflicts_total',
      help: 'Total number of slot booking conflicts encountered under concurrency',
      registers: [this.registry],
    });

    // Idempotency replays counter
    this.idempotencyReplaysTotal = new Counter({
      name: 'idempotency_replays_total',
      help: 'Total number of idempotent replayed responses served',
      registers: [this.registry],
    });

    // Outbox oldest pending event lag in seconds
    this.outboxLagSeconds = new Gauge({
      name: 'outbox_lag_seconds',
      help: 'Age in seconds of the oldest pending event in outbox_events',
      registers: [this.registry],
    });

    // Queue depth (pending + processing outbox events)
    this.queueDepth = new Gauge({
      name: 'queue_depth',
      help: 'Total number of pending and processing events in outbox queue',
      registers: [this.registry],
    });

    this.outboxPendingTotal = new Gauge({
      name: 'outbox_pending_total',
      help: 'Current count of pending events in outbox_events',
      registers: [this.registry],
    });

    this.outboxDlqTotal = new Gauge({
      name: 'outbox_dlq_total',
      help: 'Current count of events in Dead Letter Queue (DLQ)',
      registers: [this.registry],
    });

    // Payment provider errors counter
    this.paymentProviderErrorsTotal = new Counter({
      name: 'payment_provider_errors_total',
      help: 'Total payment provider API failures and timeouts',
      labelNames: ['provider', 'error_type'],
      registers: [this.registry],
    });

    // Circuit breaker state gauge (0: CLOSED, 1: HALF_OPEN, 2: OPEN)
    this.circuitBreakerState = new Gauge({
      name: 'circuit_breaker_state',
      help: 'Current circuit breaker state (0: CLOSED, 1: HALF_OPEN, 2: OPEN)',
      labelNames: ['name'],
      registers: [this.registry],
    });

    // Database connection pool gauge
    this.dbPoolConnections = new Gauge({
      name: 'db_pool_connections',
      help: 'PostgreSQL database connection pool utilization',
      labelNames: ['state'], // 'used' | 'idle' | 'max' | 'waiting'
      registers: [this.registry],
    });
  }

  onModuleInit() {
    // Initial metric seedings
    this.circuitBreakerState.set({ name: 'mock_payment' }, 0);
    this.outboxLagSeconds.set(0);
    this.queueDepth.set(0);
    this.outboxPendingTotal.set(0);
    this.outboxDlqTotal.set(0);
  }

  /**
   * Sanitizes and normalizes route path to route template, ensuring zero high-cardinality labels.
   */
  public normalizeRoute(url: string, routeTemplate?: string): string {
    if (routeTemplate && routeTemplate.startsWith('/')) {
      return routeTemplate;
    }

    const pathOnly = url.split('?')[0];

    // Replace UUIDs with :id
    const uuidRegex = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
    let normalized = pathOnly.replace(uuidRegex, ':id');

    // Replace numeric segments with :id
    normalized = normalized.replace(/\/\d+(?=\/|$)/g, '/:id');

    return normalized || '/';
  }

  public recordHttpRequest(
    method: string,
    route: string,
    statusCode: number,
    durationSeconds: number,
  ): void {
    const labels = {
      method: method.toUpperCase(),
      route,
      status_code: String(statusCode),
    };
    this.httpRequestDuration.observe(labels, durationSeconds);
    this.httpRequestsTotal.inc(labels);
  }

  public recordBookingAttempt(result: 'success' | 'conflict' | 'validation_error' | 'error'): void {
    this.bookingAttemptsTotal.inc({ result });
    if (result === 'conflict') {
      this.slotConflictsTotal.inc();
    }
  }

  public recordSlotConflict(): void {
    this.slotConflictsTotal.inc();
    this.bookingAttemptsTotal.inc({ result: 'conflict' });
  }

  public recordIdempotencyReplay(): void {
    this.idempotencyReplaysTotal.inc();
  }

  public recordPaymentProviderError(provider: string = 'mock', errorType: string = 'error'): void {
    this.paymentProviderErrorsTotal.inc({ provider, error_type: errorType });
  }

  public setCircuitBreakerState(name: string, state: 'CLOSED' | 'HALF_OPEN' | 'OPEN'): void {
    const val = state === 'CLOSED' ? 0 : state === 'HALF_OPEN' ? 1 : 2;
    this.circuitBreakerState.set({ name }, val);
  }

  public updateOutboxMetrics(pending: number, lagSeconds: number, dlqCount: number = 0): void {
    this.outboxPendingTotal.set(pending);
    this.queueDepth.set(pending);
    this.outboxLagSeconds.set(lagSeconds);
    this.outboxDlqTotal.set(dlqCount);
  }

  public updateDbPoolMetrics(used: number, idle: number, max: number, waiting: number = 0): void {
    this.dbPoolConnections.set({ state: 'used' }, used);
    this.dbPoolConnections.set({ state: 'idle' }, idle);
    this.dbPoolConnections.set({ state: 'max' }, max);
    this.dbPoolConnections.set({ state: 'waiting' }, waiting);
  }

  public async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }

  public getContentType(): string {
    return this.registry.contentType;
  }
}
