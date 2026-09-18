# Booking Sequence Diagram

Happy path and all failure paths for the booking → payment → confirmation saga.

## Happy Path

```mermaid
sequenceDiagram
    actor Patient
    participant API as API Server
    participant DB as PostgreSQL
    participant Redis
    participant Queue as BullMQ
    participant Worker
    participant PayProvider as Payment Provider (Mock)

    Patient->>API: POST /consultations (Idempotency-Key: X)
    API->>API: Validate DTO, check rate limit
    API->>DB: Check idempotency_keys for key X
    DB-->>API: Not found (new request)

    rect rgb(230, 245, 230)
        Note over API,DB: Transaction BEGIN
        API->>DB: UPDATE availability_slots SET status='HELD'<br/>WHERE id=$slot AND status='AVAILABLE'
        DB-->>API: 1 row updated
        API->>Redis: SET slot-hold:{slot_id} EX 300 (5 min TTL)
        API->>DB: INSERT consultation (status=PENDING_PAYMENT)
        API->>DB: UPDATE slot SET status='RESERVED'
        API->>DB: INSERT outbox_events (consultation.created)
        API->>DB: INSERT idempotency_keys (key X, request_hash, response)
        Note over API,DB: Transaction COMMIT
    end

    API-->>Patient: 201 Created {consultation_id, payment_url}

    Queue->>Worker: Outbox poller picks up consultation.created
    Worker->>PayProvider: Create payment intent (HMAC-signed)
    PayProvider-->>Worker: intent_id
    Worker->>DB: UPDATE consultation SET payment_intent_id

    Note over Queue: Delayed job: payment-timeout (15 min)

    PayProvider->>API: POST /webhooks/payment (HMAC signature)
    API->>API: Verify HMAC signature
    API->>DB: Check processed_webhook_events for event_id
    DB-->>API: Not found (new webhook)

    rect rgb(230, 245, 230)
        Note over API,DB: Transaction BEGIN
        API->>DB: INSERT processed_webhook_events
        API->>DB: UPDATE consultation SET status='CONFIRMED'
        API->>DB: UPDATE slot SET status='BOOKED'
        API->>DB: INSERT outbox_events (consultation.confirmed)
        Note over API,DB: Transaction COMMIT
    end

    API-->>PayProvider: 200 OK
    Queue->>Worker: Outbox poller picks up consultation.confirmed
    Worker->>Patient: Send confirmation notification (email/push)
```

## Failure Path 1: Slot Conflict (Double Booking Attempt)

```mermaid
sequenceDiagram
    actor Patient
    participant API as API Server
    participant DB as PostgreSQL

    Patient->>API: POST /consultations (Idempotency-Key: Y)
    API->>DB: Check idempotency_keys for key Y
    DB-->>API: Not found
    API->>DB: UPDATE availability_slots<br/>SET status='HELD'<br/>WHERE id=$slot AND status='AVAILABLE'
    DB-->>API: 0 rows updated (slot already HELD/RESERVED/BOOKED)
    Note over API,DB: Transaction ROLLBACK
    API-->>Patient: 409 Conflict {"error": "Slot no longer available"}
    API->>DB: INSERT idempotency_keys (key Y, request_hash, 409 response)
```

## Failure Path 2: Payment Failure (Webhook: status=FAILED)

```mermaid
sequenceDiagram
    participant PayProvider as Payment Provider
    participant API as API Server
    participant DB as PostgreSQL
    participant Queue as BullMQ
    participant Worker

    PayProvider->>API: POST /webhooks/payment {status: FAILED, event_id: E1}
    API->>API: Verify HMAC
    API->>DB: Check processed_webhook_events for E1
    DB-->>API: Not found

    rect rgb(255, 230, 230)
        Note over API,DB: Compensation Transaction BEGIN
        API->>DB: INSERT processed_webhook_events (E1)
        API->>DB: UPDATE consultation SET status='CANCELLED'
        API->>DB: UPDATE slot SET status='AVAILABLE'
        API->>DB: INSERT outbox_events (consultation.payment_failed)
        Note over API,DB: Compensation Transaction COMMIT
    end

    API-->>PayProvider: 200 OK
    Queue->>Worker: Outbox poller: consultation.payment_failed
    Worker->>Worker: Send failure notification to patient
```

## Failure Path 3: Payment Timeout (No Webhook Within 15 Minutes)

```mermaid
sequenceDiagram
    participant Queue as BullMQ
    participant Worker
    participant DB as PostgreSQL

    Note over Queue: Delayed job fires after 15 min
    Queue->>Worker: payment-timeout job {consultation_id}
    Worker->>DB: SELECT consultation<br/>WHERE id=$id AND status='PENDING_PAYMENT'
    DB-->>Worker: Found (still pending)

    rect rgb(255, 230, 230)
        Note over Worker,DB: Compensation Transaction BEGIN
        Worker->>DB: UPDATE consultation SET status='CANCELLED'
        Worker->>DB: UPDATE slot SET status='AVAILABLE'
        Worker->>DB: INSERT outbox_events (consultation.timeout_cancelled)
        Note over Worker,DB: Compensation Transaction COMMIT
    end

    Worker->>Worker: Send timeout notification to patient

    Note over Worker: Late webhook arrives after timeout
    Note over Worker: processed_webhook_events prevents re-processing
    Note over Worker: If payment actually succeeded, outbox event triggers refund job
```

## Failure Path 4: Duplicate Request (Same Idempotency-Key)

```mermaid
sequenceDiagram
    actor Patient
    participant API as API Server
    participant DB as PostgreSQL

    Patient->>API: POST /consultations (Idempotency-Key: X, same body)
    API->>DB: Check idempotency_keys for key X
    DB-->>API: Found (key X, matching request_hash)
    API-->>Patient: 201 Created (stored response replayed)

    Note over API: Different body with same key
    Patient->>API: POST /consultations (Idempotency-Key: X, different body)
    API->>DB: Check idempotency_keys for key X
    DB-->>API: Found (key X, hash mismatch)
    API-->>Patient: 422 Unprocessable Entity {"error": "Idempotency key reused with different request"}
```

## Failure Path 5: Worker Crash Mid-Outbox Relay

```mermaid
sequenceDiagram
    participant Poller as Outbox Poller (Worker)
    participant DB as PostgreSQL
    participant Queue as BullMQ
    participant NewWorker as Recovered Worker

    Poller->>DB: SELECT FROM outbox_events<br/>WHERE status='PENDING'<br/>AND created_at < now() - 30s
    DB-->>Poller: [{id: 42, type: consultation.created, payload: ...}]
    Poller->>DB: UPDATE outbox_events SET status='PROCESSING' WHERE id=42
    Poller->>Queue: Enqueue job for consultation.created
    Note over Poller: ❌ WORKER CRASHES before marking PROCESSED

    Note over DB: outbox_events row 42 stuck in PROCESSING

    Note over NewWorker: New worker instance starts
    NewWorker->>DB: SELECT FROM outbox_events<br/>WHERE status='PROCESSING'<br/>AND updated_at < now() - 60s
    DB-->>NewWorker: [{id: 42, stuck for >60s}]
    NewWorker->>DB: UPDATE outbox_events SET status='PENDING' WHERE id=42
    Note over NewWorker: Normal polling picks it up again
    NewWorker->>DB: SELECT FROM outbox_events WHERE status='PENDING'
    NewWorker->>Queue: Re-enqueue consultation.created
    NewWorker->>DB: UPDATE outbox_events SET status='PROCESSED'

    Note over NewWorker: Consumer is idempotent:
    Note over NewWorker: checks processed_events table before acting
```
