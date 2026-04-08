# Research: NestJS CQRS + Transactional Outbox (Production Patterns)

**Topic:** How to make NestJS CQRS command/event flows reliable in production, eliminating lost events and double-publication failures.
**Date:** 2026-04-08
**Agent:** farm-expert

## Sources
- [NestJS CQRS docs](https://docs.nestjs.com/recipes/cqrs)
- [NestJS CQRS does not implement outbox (GitHub issue #113)](https://github.com/nestjs/cqrs/issues/113)
- [Outbox Pattern with Kafka and NestJS (DEV)](https://dev.to/wallacefreitas/outbox-pattern-with-kafka-and-nestjs-ensuring-reliable-event-driven-systems-2f5k)
- [Navigating CQRS and Event Sourcing with NestJS (Medium / Digital Frontiers)](https://medium.com/digitalfrontiers/navigating-cqrs-and-event-sourcing-my-journey-with-nestjs-and-eventstoredb-part-1-cebbe6bcff2e)
- [CQRS Pattern in Microservices (OneUptime, Jan 2026)](https://oneuptime.com/blog/post/2026-01-30-cqrs-pattern-microservices/view)

## Key Findings

1. **`@nestjs/cqrs` does NOT ship with an outbox.** The module publishes events in-memory by default. If a command handler commits its DB transaction successfully but the process crashes before the event reaches NATS, the event is permanently lost. This is the single most common production failure mode in NestJS CQRS.
2. **Correct flow:** validate → open transaction → persist aggregate → persist outbox row in the SAME transaction → commit → background publisher polls outbox → publishes to NATS → marks outbox row as published.
3. **Custom `IEventPublisher`:** `@nestjs/cqrs` exposes a plugin point to swap the default in-memory publisher with one that writes to a Postgres outbox table. This is the idiomatic way to add reliability without forking the module.
4. **Publishing inside a transaction is a CRITICAL bug** — if the transaction rolls back, the event has already left the process and consumers will react to an aggregate state that was never persisted.
5. **Idempotent consumers are mandatory.** Exactly-once delivery does not exist at the broker level alone; consumers must deduplicate via message ID or domain-level natural key.
6. **Concurrent command handling on the same aggregate** requires either optimistic concurrency (`expectedVersion` on the event stream) or pessimistic locks. NestJS CQRS does not provide concurrency control — the aggregate repository must.
7. **Saga orchestration** in NestJS CQRS reacts to events synchronously; long-running sagas must persist state between steps or risk losing progress on a restart.

## Security Concerns
- Outbox rows may contain sensitive payload data. If the outbox table is readable by unprivileged roles, the outbox becomes an exfiltration channel. Encrypt sensitive fields at rest or restrict table access.
- Events published by the outbox poller must still respect tenant isolation — the poller connection must set the correct `search_path` or explicitly filter by tenant.
- A compromised outbox publisher could replay historical events and cause double-spending in financial flows. Outbox consumer idempotency keys must be derived from the original command, not from the outbox row ID.

## Performance Concerns
- The outbox poller is a hot loop. Tune polling interval against event volume — too aggressive starves the DB, too slow inflates end-to-end latency.
- Batch publishing (N events per poll) dramatically improves throughput versus one-at-a-time.
- Outbox table grows unbounded if not pruned. Pruning published rows older than N days is mandatory — otherwise index bloat degrades the poller query.
- Every CRITICAL event flow must have a DLQ (dead-letter queue) for events that fail publication after N retries, with monitoring on DLQ depth.

## Architectural Implications for farm-expert reviews
- Any command handler that publishes directly to NATS (bypassing the outbox) is a **CRITICAL** finding.
- Any command handler that publishes events inside an open transaction (before `commit()`) is a **CRITICAL** finding.
- Missing `@Optional() @Inject('EVENT_BUS')` pattern — a **HIGH** finding.
- Absence of outbox poller prometheus metrics (lag, DLQ depth, retry count) — **HIGH** observability finding.
- Consumer handlers without idempotency protection — **HIGH** finding.

## Domain Rule Additions for farm-expert

Add to `## Domain Rules → CQRS Compliance`:
- Events published directly to NATS from command handlers (bypassing outbox) = CRITICAL violation — violates reliability contract, events lost on crash.
- Events published before `commit()` inside an open transaction = CRITICAL — events fire even on rollback, consumers see phantom state.
- Missing outbox DLQ metrics (depth, retry count, age of oldest unpublished row) = HIGH observability violation.
- Consumers without natural-key or message-id idempotency = HIGH — exactly-once delivery requires consumer-side dedup.
- Outbox table growth unbounded (no pruning policy) = MEDIUM maintenance debt that becomes HIGH after ~30 days.
