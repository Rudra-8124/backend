# ADR-003: Idempotency Strategy

## Status
Accepted

## Context
The assignment explicitly requires idempotency for all write operations. Network retries, client timeouts, and load-balancer retries can cause duplicate requests. Payment webhooks may be delivered multiple times.

## Decision
Two-layer idempotency:
1. **Client-facing**: `Idempotency-Key` header required on all state-changing API endpoints.
2. **Webhook-facing**: `processed_webhook_events` table with `UNIQUE(provider, event_id)`.

## Mechanism

### Client Idempotency

```
Request arrives with Idempotency-Key: X
  → Look up idempotency_keys WHERE user_id = $user AND idempotency_key = X
  → FOUND + matching request_hash → replay stored response (same status code + body)
  → FOUND + different request_hash → 422 Unprocessable Entity
  → NOT FOUND → execute the request
    → In the SAME transaction as the business logic:
      INSERT INTO idempotency_keys (user_id, idempotency_key, request_hash, response_status, response_body, expires_at)
    → COMMIT
    → Return response
```

### Key Design Choices

| Choice | Decision | Rationale |
|--------|----------|-----------|
| Key scope | Per-user | Prevents cross-user collision; user A's key "abc" is independent of user B's |
| Key uniqueness | `UNIQUE(user_id, idempotency_key)` | Enforced at DB level |
| Request matching | SHA-256 hash of canonicalized request body | Detects key reuse with different payload |
| Response storage | Status code + JSON body | Full replay, client sees exact same response |
| TTL | 7 days | Long enough for retries, short enough for storage |
| Cleanup | BullMQ cron job deletes expired rows | Prevents unbounded growth |

### Webhook Idempotency

Payment webhooks use the provider's `event_id` as the natural idempotency key:
```
Webhook arrives with event_id: E1
  → INSERT INTO processed_webhook_events (provider, event_id, response_body)
  → If UNIQUE violation → return stored response_body
  → If INSERT succeeds → process the webhook in a transaction
```

### Concurrency

Two identical requests arriving simultaneously:
- The `INSERT INTO idempotency_keys` will hit the UNIQUE constraint for the second request.
- The second request catches the unique violation, reads the stored response, and replays it.
- If the first request hasn't committed yet, the second request's INSERT will block on the row lock, then succeed or fail depending on the first's outcome.

## Trade-offs
- **Pro**: Guaranteed exactly-once processing for any idempotent-key-bearing request.
- **Pro**: Transparent replay — client gets the same response without re-executing.
- **Con**: Extra DB write on every state-changing request (idempotency_keys INSERT).
- **Con**: 7-day TTL means keys can be reused after expiry (acceptable — client should generate new UUIDs).
- **Con**: Large response bodies increase storage (mitigated: pruning + responses are typically small JSON).

## Consequences
- A NestJS interceptor/middleware handles idempotency checks before the controller runs.
- All state-changing controllers are decorated with `@Idempotent()`.
- Login and refresh are exempt (idempotent by nature — same credentials yield new tokens).
- The idempotency layer runs outside the business transaction but stores the response inside it.
