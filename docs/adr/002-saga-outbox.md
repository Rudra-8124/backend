# ADR-002: Saga Pattern with Transactional Outbox

## Status
Accepted

## Context
The booking flow spans multiple state changes: reserve slot → create consultation → create payment intent → confirm on payment success. If any step fails, prior steps must be compensated. We need reliable event delivery for downstream processing (notifications, analytics).

## Decision
Use a **choreography-based saga** with a **transactional outbox** pattern.

## How It Works

### Saga Steps
1. **Reserve**: In a single DB transaction: UPDATE slot → HELD, INSERT consultation (PENDING_PAYMENT), UPDATE slot → RESERVED, INSERT outbox_event (`consultation.created`), INSERT idempotency_key.
2. **Pay**: Outbox poller picks up `consultation.created`, worker calls mock payment provider, schedules a 15-min timeout job.
3. **Confirm**: Payment webhook arrives → in a single DB transaction: INSERT processed_webhook_event, UPDATE consultation → CONFIRMED, UPDATE slot → BOOKED, INSERT outbox_event (`consultation.confirmed`).

### Compensation
| Trigger | Action |
|---------|--------|
| Payment timeout (15 min, no webhook) | consultation → CANCELLED, slot → AVAILABLE |
| Payment webhook: FAILED | consultation → CANCELLED, slot → AVAILABLE |
| Late success webhook after timeout | Refund job triggered via outbox |

### Outbox Details
- **Table**: `outbox_events` with status PENDING → PROCESSING → PROCESSED.
- **Poller**: BullMQ recurring job (every 5 seconds) queries for PENDING events older than 30 seconds (delay avoids racing with the committing transaction).
- **Stuck detection**: Events in PROCESSING for > 60 seconds are reset to PENDING (handles worker crashes).
- **At-least-once delivery**: Events may be delivered more than once. Consumers are idempotent (check `processed_events` or use natural idempotency of the operation).
- **Pruning**: Processed events older than 7 days are deleted by a scheduled job.

## Why Not Orchestration?
| Factor | Choreography + Outbox | Orchestrator (e.g., Temporal) |
|--------|----------------------|-------------------------------|
| Infrastructure | Just Postgres + BullMQ | Temporal server cluster |
| Complexity | Simple for 3 steps | Overkill for 3 steps |
| Debuggability | Query outbox_events table | Temporal UI |
| Reliability | DB transaction guarantees | Temporal guarantees |

For a 3-step saga, choreography with outbox is simpler and sufficient. An orchestrator becomes worthwhile at 5+ steps or complex branching.

## Trade-offs
- **Pro**: No additional infrastructure beyond Postgres and Redis/BullMQ.
- **Pro**: Events are guaranteed to be published (same transaction as state change).
- **Pro**: Natural audit trail in outbox_events table.
- **Con**: Polling introduces latency (up to 5 seconds for event pickup).
- **Con**: At-least-once requires idempotent consumers.
- **Con**: Outbox table must be pruned to avoid unbounded growth.

## Consequences
- All state changes that produce events must include an outbox INSERT in the same transaction.
- Worker process must run the outbox poller as a recurring BullMQ job.
- Consumers must check for duplicate processing before acting.
