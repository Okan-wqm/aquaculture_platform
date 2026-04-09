# Package 13: messaging-storage-redis-resilience

## Metadata
Status: IMPLEMENTED
Estimated Tokens: 22K
Priority: MEDIUM
Security-Sensitive: no
Parallelizable: yes
Prerequisites: none

## Closing-Findings
Closing-Findings: [MSG-MEDIUM-008, MSG-MEDIUM-017, MSG-MEDIUM-023, MSG-MEDIUM-028, MSG-MEDIUM-037, MSG-MEDIUM-043, MSG-MEDIUM-045]

## Source-Reviews
- docs/reviews/orchestrator/2026-04-09-full-platform-audit.md

## Context
Seven messaging findings cover outbox bypass, Redis circuit breaking, cache consistency, memory-bound exports, consent TTL, presence cleanup, and retention partition strategy. All are within `apps/messaging-service/src/`. Grouped by service locality and shared infrastructure concerns (Redis, outbox, storage).

## Findings

**MSG-MEDIUM-008 — StorageQuota event bypasses transactional outbox**
The storage quota check publishes a `StorageQuotaExceededEvent` directly via the event bus instead of enqueueing through the transactional outbox. If the event bus publish fails, the quota breach is silently lost. Route through OutboxPublisher.

**MSG-MEDIUM-017 — No Redis circuit breaker**
Messaging service calls Redis for presence, caching, and pub/sub without a circuit breaker. If Redis is down, every request waits for the Redis timeout (default 5s), cascading to API latency spikes. Add a circuit breaker that falls back to degraded mode (e.g., skip cache, assume presence stale).

**MSG-MEDIUM-023 — No Redis cache invalidation for legal hold status**
Legal hold status is cached in Redis with a fixed TTL. When a legal hold is toggled, the cache is not explicitly invalidated. A message under legal hold could be deleted during the cache staleness window. Invalidate on toggle.

**MSG-MEDIUM-028 — Data export loads all messages into memory**
`data-export.service.ts` loads all messages for a GDPR export into a single array before writing to file. For tenants with large message volumes, this causes OOM. Use a streaming cursor (TypeORM `createQueryBuilder().stream()`) and pipe to file.

**MSG-MEDIUM-037 — Consent cache TTL 10 minutes too long**
AI consent status (user's opt-in/opt-out for AI features) is cached for 10 minutes. If a user revokes consent, AI features continue for up to 10 minutes. Reduce TTL to 60 seconds or invalidate on consent change.

**MSG-MEDIUM-043 — No presence cleanup on disconnect**
When a WebSocket disconnects, the user's presence status is not immediately cleaned up. It relies on Redis key TTL expiry (default 30s). During this window, the user appears online to others. Add explicit `DEL` on disconnect event.

**MSG-MEDIUM-045 — Retention policy uses row DELETE instead of partition DROP**
The message retention service deletes expired messages row-by-row (`DELETE FROM messages WHERE created_at < ...`). For TimescaleDB hypertables, `drop_chunks()` is orders of magnitude faster and generates no WAL bloat. Use `drop_chunks()` for retention.

## Affected Files
- apps/messaging-service/src/compliance/services/data-export.service.ts
- apps/messaging-service/src/compliance/services/retention-policy.service.ts
- apps/messaging-service/src/compliance/services/legal-hold.service.ts
- apps/messaging-service/src/presence/presence.service.ts
- apps/messaging-service/src/ai/services/ai-privacy.service.ts (consent cache)
- apps/messaging-service/src/notification/ or core/ (StorageQuota event publishing)
- libs/backend-common/src/ (Redis circuit breaker, if shared)

## Dependencies
None. Messaging service is self-contained.

## Atomic Commit Plan
```
fix(messaging): route StorageQuota through outbox, add Redis circuit breaker, invalidate legal hold cache, stream exports, reduce consent TTL, cleanup presence, use drop_chunks for retention

Seven messaging resilience fixes:
- Route StorageQuotaExceededEvent through OutboxPublisher instead of direct eventBus
- Add Redis circuit breaker with degraded-mode fallback
- Invalidate legal hold Redis cache on hold toggle
- Stream GDPR export via cursor instead of loading all into memory
- Reduce consent cache TTL to 60s and invalidate on consent change
- Explicit Redis DEL on WebSocket disconnect for presence cleanup
- Replace row-by-row DELETE with TimescaleDB drop_chunks() for retention

Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#MSG-MEDIUM-008
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#MSG-MEDIUM-017
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#MSG-MEDIUM-023
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#MSG-MEDIUM-028
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#MSG-MEDIUM-037
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#MSG-MEDIUM-043
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#MSG-MEDIUM-045
Plan: docs/plans/2026-04-09-medium-fixes/packages/13-messaging-storage-redis-resilience.md
```

## Test Plan
- Unit test: StorageQuota event enqueued via OutboxPublisher (mock OutboxPublisher.enqueue)
- Unit test: Redis circuit breaker opens after N failures, returns fallback
- Unit test: legal hold toggle invalidates Redis cache key
- Integration test: GDPR export for 100K messages does not exceed 256MB heap
- Unit test: consent cache invalidated on revocation, not just TTL
- Unit test: presence DEL called on WebSocket disconnect event
- Integration test: retention service calls drop_chunks() not DELETE

## Verification Command
`npx tsc --noEmit -p apps/messaging-service/tsconfig.json && npx jest --testPathPattern="apps/messaging-service" --coverage=false`

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes
