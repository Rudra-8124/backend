# ADR-001: Modular Monolith Architecture

## Status
Accepted

## Context
The assignment requires a production-grade backend supporting 100k daily consultations with multiple domains (auth, booking, payments, prescriptions, search, audit, analytics). We must choose between microservices, a modular monolith, or a traditional monolith.

## Decision
**Modular monolith**: one codebase, two entrypoints (stateless API server, background worker), with 10 NestJS modules that have clean boundaries.

## Modules
`auth`, `users`, `doctors`, `availability`, `consultations`, `prescriptions`, `payments`, `search`, `audit`, `admin-analytics`

## Rationale

| Factor | Modular Monolith | Microservices |
|--------|------------------|---------------|
| Deployment complexity | Single deploy, two processes | N deploys, service mesh, API gateway |
| Data consistency | Single DB, real transactions | Distributed transactions, eventual consistency |
| Latency | In-process calls | Network hops between services |
| Team size (1 dev) | Manageable | Extreme overhead |
| Extractability | Modules can become services later | Already separated |
| Observability | Simpler (one process) | Distributed tracing mandatory |

**Why not a traditional monolith?** Modules enforce boundaries: each module exports only its service interface, never its repository or entities directly. Cross-module communication uses events (via the outbox) or well-defined service methods. This makes future extraction to microservices a mechanical refactoring, not a redesign.

## Trade-offs
- **Pro**: Transactional consistency across modules (e.g., booking saga uses a single DB transaction for slot + consultation + outbox).
- **Pro**: Simpler deployment and debugging for a single developer.
- **Pro**: In-process calls are faster than network calls (~0ms vs ~1-5ms).
- **Con**: All modules share the same process; a memory leak in one affects all.
- **Con**: Cannot scale modules independently (mitigated: the worker process scales separately from the API).
- **Con**: Module boundary discipline requires code review vigilance.

## Extraction path
Each module already communicates via events (outbox_events table). To extract:
1. Stand up the module as its own service with its own DB.
2. Replace in-process event emission with a message broker (e.g., SQS/SNS).
3. Replace direct service calls with API calls or gRPC.
4. Run both in parallel, shadow-test, cut over.

## Consequences
- CI runs all tests in one pipeline (fast feedback).
- Shared TypeORM connection, but each module owns its entities.
- Module-level `index.ts` barrel files control the public API.
