# Observability Architecture & Debugging Runbook

Amrutam Telemedicine Backend implements production-grade end-to-end observability across the three core telemetry pillars: **Metrics**, **Traces**, and **Logs**, unified by **W3C Trace Context propagation** across synchronous REST endpoints and asynchronous outbox/saga background workers.

---

## 1. System Architecture

```mermaid
flowchart TD
    Client["Client / Browser"] -->|HTTP Request\n(traceparent)| API["Amrutam API\n(Fastify + NestJS)"]
    API -->|Auto HTTP/PG/Redis Span\n+ Manual Spans| OTelAPI["OpenTelemetry SDK"]
    API -->|Write Outbox Event\nwith traceparent| DB[(PostgreSQL 16)]
    API -->|Scrape /metrics| Prom["Prometheus"]
    API -->|Structured JSON Logs\nwith trace_id/span_id| Loki["Grafana Loki"]

    Worker["Worker Process\n(Outbox Relay & Sagas)"] -->|Extract traceparent\nContinue Trace| OTelWorker["OpenTelemetry SDK"]
    Worker -->|Process Outbox Batch| DB
    Worker -->|JSON Logs with trace_id| Loki

    OTelAPI -->|OTLP gRPC/HTTP: 4317/4318| Collector["OpenTelemetry Collector"]
    OTelWorker -->|OTLP gRPC/HTTP: 4317/4318| Collector
    Collector -->|Forward Traces| Tempo["Grafana Tempo"]
    Collector -->|Forward Metrics| Prom

    Prom -->|Alert Rules / SLO Burn Rate| AlertManager["Alertmanager / PagerDuty"]
    Grafana["Grafana (Dashboards)"] -->|Query Metrics| Prom
    Grafana -->|Query Traces| Tempo
    Grafana -->|Query Logs| Loki
```

---

## 2. Telemetry Signals Explained

### 2.1 Prometheus Metrics

All metrics are exposed at `GET /metrics` in standard Prometheus exposition format.

#### RED Metrics (Rate, Errors, Duration) per Route Template
To prevent **high-cardinality label explosion** in time-series databases, route paths are strictly mapped to their parameterized **Route Templates** (e.g., `/consultations/:id`, `/doctors/:id`, `/admin/analytics/consultations`) rather than dynamic request URLs containing raw UUIDs or tokens.

- `http_requests_total{method, route, status_code}`: Counter measuring incoming traffic volume and error status codes.
- `http_request_duration_seconds_bucket{method, route, status_code, le}`: Histogram measuring request latency distribution across standard SRE buckets (`0.005s` to `10s`).

#### Booking & Concurrency Funnel Metrics
- `booking_attempts_total{result}`: Counter of all consultation booking requests labeled by outcome:
  - `result="success"`: Slot successfully held and consultation created.
  - `result="conflict"`: Slot contended / 409 conflict under concurrent race.
  - `result="validation_error"`: Payload validation error (400 / 422).
  - `result="error"`: Internal server or database error (5xx).
- `slot_conflicts_total`: Counter tracking exact number of 409 slot contention events.
- `idempotency_replays_total`: Counter tracking requests answered from stored idempotent responses with `Idempotency-Replay: true`.

#### Queue & Outbox Health Metrics
- `outbox_lag_seconds`: Gauge measuring the age in seconds of the oldest un-relayed event with status `PENDING` in `outbox_events`.
- `outbox_pending_total` / `queue_depth`: Gauge indicating backlog size of events awaiting processing.
- `outbox_dlq_total`: Gauge tracking total dead-lettered events (`DLQ`) requiring operator intervention.

#### Resilience & Infrastructure Metrics
- `payment_provider_errors_total{provider, error_type}`: Counter incremented when the payment provider returns network errors or HTTP 5xx.
- `circuit_breaker_state{name}`: Gauge reflecting payment circuit breaker state (`0: CLOSED`, `1: HALF_OPEN`, `2: OPEN`).
- `db_pool_connections{state}`: Gauge tracking PostgreSQL pool connections across states: `used`, `idle`, `max`, `waiting`.

---

### 2.2 Distributed Tracing & W3C Context Propagation

#### Unified Booking Trace across API and Worker
Distributed transactions in microservices and modular monoliths frequently lose context across asynchronous queues. Amrutam solves this by serializing the active W3C `traceparent` string (`00-${traceId}-${spanId}-${traceFlags}`) into the `outbox_events.traceparent` database column and payload metadata upon event insertion.

When the worker claims the outbox event via `SELECT ... FOR UPDATE SKIP LOCKED`, it extracts the `traceparent` and runs inside `withTraceparentContext(traceparent, ...)`. As a result, the entire booking saga appears in Grafana Tempo as **ONE unbroken trace**:

```
[HTTP POST /consultations] (API Server - 35ms)
 ├── [booking.hold_slot] (Conditional UPDATE on availability_slots - 4ms)
 └── [booking.create_consultation] (INSERT consultation + outbox_events - 6ms)
        │
        ▼ (Asynchronous Outbox DB Relay - 2s polling window)
[outbox.process:consultation.created] (Worker Process - 52ms)
 └── [saga.create_payment_intent] (MockPaymentProvider.createIntent - 45ms)
        │
        ▼ (Payment Webhook)
[HTTP POST /webhooks/payments] (API Server - 28ms)
 └── [saga.confirm_consultation] (ConsultationStateMachine transition to CONFIRMED - 8ms)
```

---

### 2.3 Structured Logging with Trace Correlation

All logs are emitted as structured JSON to `stdout` via Pino:
- **Trace Context**: Automatically includes `trace_id` and `span_id` extracted from the active OpenTelemetry span.
- **PII / PHI Redaction**: Passwords, tokens, totp codes, authorization headers, and clinical notes are redacted (`[REDACTED]`) before output.

```json
{
  "level": 30,
  "time": 1726798000000,
  "pid": 21228,
  "hostname": "amrutam-api",
  "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
  "span_id": "00f067aa0ba902b7",
  "req": {
    "method": "POST",
    "url": "/consultations",
    "remoteAddress": "127.0.0.1"
  },
  "msg": "Consultation created with slot held",
  "consultationId": "73d7452e-c529-43c2-8438-e69d95fbc9a1",
  "slotId": "b182c1b1-2ce0-482a-9e1e-450ff7b5c192"
}
```

---

## 3. Service Level Objectives (SLO) & Alerting Rules

### 3.1 Availability SLO: 99.95% Availability
- **Target**: 99.95% of requests succeed over any rolling 30-day window.
- **Error Budget**: $1 - 0.9995 = 0.0005$ (0.05% error rate allowed).

#### Multi-Window Multi-Burn-Rate Alerting Strategy
Following Google SRE best practices, alerts combine a short window and a long window to prevent false positives while rapidly detecting severe outages:

1. **Fast Burn Alert (`AvailabilitySLOFastBurn`)**:
   - **Condition**: Consuming error budget at **14.4x** rate (2% of monthly budget consumed in 1 hour).
   - **Windows**: 5-minute short window AND 1-hour long window both exceeding $0.72\%$ error rate.
   - **Severity**: `critical` (Immediate on-call page).
2. **Slow Burn Alert (`AvailabilitySLOSlowBurn`)**:
   - **Condition**: Consuming error budget at **6x** rate (5% of monthly budget consumed in 6 hours).
   - **Windows**: 30-minute short window AND 6-hour long window both exceeding $0.30\%$ error rate.
   - **Severity**: `warning` (Workday ticket).

### 3.2 Latency Budgets
- **Read Latency**: `p95 < 200ms` (`ReadLatencyOverBudget` alert triggers if GET p95 > 200ms for 5 minutes).
- **Write Latency**: `p95 < 500ms` (`WriteLatencyOverBudget` alert triggers if mutating p95 > 500ms for 5 minutes).

### 3.3 Pipeline & Operational Alerts
- `OutboxLagCritical`: Triggers if `outbox_lag_seconds > 60` for 2 minutes (worker starved or crashed).
- `DLQGrowthDetected`: Triggers if `outbox_dlq_total > 0` for 1 minute.
- `ReadinessFailing`: Triggers if `/readyz` fails or Prometheus target is down for 1 minute.

---

## 4. Runbook: How to Debug a Failed Booking

When a booking failure is reported by a user, customer support, or alert, follow these 6 steps to diagnose and remediate:

### Step 1: Trace ID Lookup
1. Obtain the `Idempotency-Key`, `consultationId`, or `requestId` from user report or API response headers.
2. Open Grafana -> **Explore** -> Select datasource **Tempo**.
3. Search by tag `consultation.id="<ID>"` or `booking.slot_id="<ID>"`.
4. The full trace will display both API spans (`booking.hold_slot`, `booking.create_consultation`) and worker spans (`outbox.process:consultation.created`, `saga.create_payment_intent`).

### Step 2: Correlated Logs in Loki
1. In the Tempo trace view, click **"Trace to Logs"** on any failing span, or navigate to **Explore** -> **Loki**.
2. Query Loki with the trace ID:
   ```logql
   {job="amrutam"} | json | trace_id = "4bf92f3577b34da6a3ce929d0e0e4736"
   ```
3. Inspect error details, stack traces, and HTTP status codes.

### Step 3: Outbox & DLQ Inspection
If the consultation was created with status `PENDING_PAYMENT` but payment intent never appeared:
1. Run query against database:
   ```sql
   SELECT id, event_type, status, attempts, error, retry_count, traceparent, created_at, updated_at
   FROM outbox_events
   WHERE aggregate_id = '<consultationId>';
   ```
2. Check `status`:
   - If `PENDING`: Check `outbox_lag_seconds` in Grafana. The worker process may be paused or restarting.
   - If `PROCESSING`: The event may be stuck; verify if worker crashed (it will auto-recover after 30 seconds).
   - If `DLQ`: Check `error` column. Common causes: database connection timeout or payment provider serialization failure.

### Step 4: Slot State & Advisory Lock Verification
If the patient received HTTP 409 Conflict:
1. Run query:
   ```sql
   SELECT id, doctor_id, start_time, end_time, status, held_by, hold_expires_at
   FROM availability_slots
   WHERE id = '<slotId>';
   ```
2. If `status = 'HELD'` and `hold_expires_at > now()`:
   - The slot is legitimately held by another patient (`held_by`).
   - Normal concurrency protection; inform patient to choose another slot.
3. If `status = 'HELD'` and `hold_expires_at < now()`:
   - Hold expired. The next booking attempt will conditionally claim it, or the background hold-expiry worker will release it within 10 seconds.

### Step 5: Payment Provider & Circuit Breaker State
If the payment step failed:
1. Check metric `circuit_breaker_state{name="mock_payment"}` in the **Booking Funnel** dashboard.
2. If state is `2` (`OPEN`): The mock payment provider has suffered repeated outages and is fast-failing requests to protect resources.
3. Review `payment_provider_errors_total` for root cause (`timeout`, `network_error`, `bad_gateway`).

### Step 6: Dead Letter Queue (DLQ) Remediation
If an event is permanently in `DLQ`:
1. Fix underlying dependency issue (e.g., payment provider outage).
2. Re-queue the failed outbox event:
   ```sql
   UPDATE outbox_events
   SET status = 'PENDING', attempts = 0, next_retry_at = now(), updated_at = now()
   WHERE id = <eventId> AND status = 'DLQ';
   ```
3. The worker will pick it up on the next 2-second polling cycle and continue the saga.
