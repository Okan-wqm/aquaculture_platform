# Phase 2: Security & Performance Review

## Security Findings (Phase 2A — security-reviewer)

### Executive summary
Two CRITICAL findings **BLOCK DEPLOYMENT**: (1) `FarmGateway.emitFarmEvent` derives the destination tenant room exclusively from the `event.tenantId` field of an unauthenticated payload — any backend service with NATS publish credentials (every microservice in the platform) can spoof events into any tenant's room; (2) the bridge does NOT cross-check the NATS subject's tenant token against the payload's `tenantId`, and `tenantId` is not regex-validated as a UUID anywhere in the gateway path, creating subject injection + log injection + room-key-poisoning vectors. Plus 4 HIGH (JWT type discriminator missing, no re-auth on long-lived streams, trusted-source XSS risk, wide-open CORS in dev/silent fail in prod) and 6 MEDIUM/6 LOW hardening gaps.

### CRITICAL (deployment blockers)

**CR-1 — Cross-tenant event fan-out via payload-controlled room routing**
- Files: `farm.gateway.ts:255-263`, `farm-nats-bridge.service.ts:206-243`
- CWE-639, CWE-863, CVSS 9.1 (drops to 9.6 if NATS auth not enforced)
- Attack: any service with NATS publish creds constructs `{ tenantId: '<victim>', eventType: 'MortalityRecorded', quantity: 99999, reason: 'DISEASE' }` and publishes to `events.<attacker>.MortalityRecorded`. Bridge receives via wildcard subscribe, routes based on payload `tenantId`, emits into victim's Socket.IO room. **Triggers false compliance reports in regulated jurisdictions (Norway IK-Akvakultur).**
- Fix: at the bridge, extract `subject.split('.')[1]` and reject if ≠ `event.tenantId`; add UUID regex enforcement at both bridge AND gateway emit; long-term add `X-Service-Identity` HMAC header to all NATS publishers

**CR-2 — No subject ↔ payload tenant cross-check + no UUID validation**
- Files: `farm-nats-bridge.service.ts:160-198, 327-342`, `nats-event-bus.ts:298-301`, `outbox-publisher.service.ts:50-78`
- CWE-20, CWE-117, CWE-915, CVSS 8.6
- 3-layer failure: (a) `OutboxPublisher.enqueue` validates only truthiness of `tenantId`, (b) `NatsEventBus.deriveSubject` template-concats `events.${tenantId}.${eventType}` with zero validation, (c) bridge `isValidEvent` only checks non-empty string. A malformed `tenantId` like `'tenant.MortalityRecorded'` produces a 4-token subject; `'*'` or `'>'` injects NATS wildcards; `'admin\n[FAKE LOG]'` injects into Loki.
- Fix: UUID regex + PascalCase enforcement at `OutboxPublisher.enqueue`; fail-closed in `deriveSubject`; this is a **shared library change** affecting every service

### HIGH
- **H-1** Missing JWT `type === 'access'` discriminator in `farm.gateway.ts:388-427` — refresh tokens (7-day TTL) and MFA-challenge tokens (pre-2FA) accepted at handshake. CVSS 7.5, CWE-345, CWE-287
- **H-2** No re-authentication after JWT validation — disabled/deleted users keep streaming events until token expiry. CVSS 7.1, CWE-613. Fix: inject `UserSessionService` + Redis pub/sub `user:revoked:{userId}` channel
- **H-3** Trusted-source XSS — event payload reflected verbatim into React Query cache; free-text `notes`/`detail`/`reason` fields uncapped. Currently safe (prefix invalidation only) but immediate footgun for the next hook iteration. CVSS 7.4, CWE-79. Fix: zod schema validation at the bridge with `.strict()` + `max(500)`
- **H-4** `buildWsCorsConfig()` runs at MODULE LOAD TIME (before ConfigService), defaults `origin: true` in dev. Production fail-closed path only WARNS, never throws. CVSS 6.5, CWE-942. Fix: move CORS into `afterInit()`, throw on missing `WS_CORS_ORIGINS` in production

### MEDIUM
- **M-1** tenantId log injection (fixed by CR-2's UUID guard)
- **M-2** Outbox worker publishes without revalidating tenantId (defense-in-depth gap at worker boundary)
- **M-3** Query-string token accepted in non-production — leaks via nginx access logs/browser history/referer. Dead code since frontend uses `auth: { token }`
- **M-4** No connection rate limit on `/farms` namespace — missing `maxHttpBufferSize`, `pingTimeout`, per-IP/per-tenant caps. CWE-770
- **M-5** Dead-letter table grows without bound — disk DoS. Add secondary cleanup at 30 days
- **M-6** Worker crash-loop risk on poison message — `publishOne` throw escapes outer loop; wrap inner call in per-row try/catch

### LOW
L-1 (OUTBOX_BATCH_SIZE hardcoded), L-2 (bigint lexical sort risk), L-3 (spoofed-event refetch DoS), L-4 (no frontend payload size limit), L-5 (cross-domain field leakage — `siteId` crosses Site service boundary), L-6 (Socket.IO event name → prototype pollution defense)

### Authentication trust chain (10 decision points)

| # | Decision | Verified? | Risk if false |
|---|---|---|---|
| 1 | JWT signed by our service | HS256 secret, not rotated | Forgeable tokens |
| 2 | JWT not revoked | **NOT checked** (H-1 follow-up) | Logged-out users stream |
| 3 | User still active | **NOT checked** (H-2) | Disabled users stream |
| 4 | Token type is 'access' | **NOT checked** (H-1) | Refresh/MFA tokens accepted |
| 5 | tenantId from real tenant | Trusted | OK |
| 6 | Origin header from allow-list | **Not enforced in dev** (H-4) | Cross-origin exfil |
| 7 | NATS publisher authentic | **NOT verified** (CR-1) | Cross-tenant fan-out |
| 8 | Event payload matches contract | **NOT verified** (H-3) | XSS |

### Defense-in-depth gaps
1. Single point of failure: bridge tenant routing — no second-layer check between bridge and room emit
2. Single point of failure: JWT secret shared across services, no per-service signing key
3. Single point of failure: NATS auth is WARN not error in production (`nats-event-bus.ts:131-141`)
4. All tenants share `/farms` namespace — isolation is purely by room name
5. No service identity on NATS messages
6. No audit log for cross-tenant routing decisions

---

## Performance Findings (Phase 2B — general-purpose performance engineer)

### Executive summary
The pipeline is **functionally correct but operationally over-budget under any non-trivial load**. The hot path is dominated by (1) the hard-coded **1s cron poll** anchoring p50 latency at ~500ms (half the budget consumed before the first byte hits NATS), (2) **per-cycle double COUNT(*)** burning 2 queries/sec/replica forever (M-7), (3) JSONB payloads **round-tripping through serialization 3 times** (handler → outbox JSONB → worker → NATS encoder). At 1 replica/100 tenants OK; at 10 replicas without SKIP LOCKED → 10× publish amplification + UPDATE contention; at 10k clients → Socket.IO emit storm + React Query refetch storm.

### Latency budget assessment

| Stage | Budget | Actual (best) | Actual (p99) | Verdict |
|---|---|---|---|---|
| Handler TX commit | 100ms | ~30-60ms | ~250-600ms | OVER (locks + N+1 loops) |
| Worker poll pickup | 1000ms | 0-1000ms (mean ~500) | 1000ms | **DOMINATES** |
| Worker publish to NATS | 50ms | ~5ms | ~30ms (or ∞ until C1 fixed) | OK if C1 fixed |
| NATS → bridge | 20ms | ~2ms | ~15ms | OK |
| Bridge → emit | 5ms | <1ms | ~3ms | OK |
| Network + RQ refetch | 200ms | ~80ms | ~800ms | OVER on burst |
| **E2E p50** | **500ms** | | **~700-900ms** | **OVER** |
| **E2E p99** | (~1.5s) | | **~2.5-4s** | **3-6× OVER** |

### CRITICAL (performance blockers)

**P-C1 — Cron poll dominates entire latency budget**
- `outbox-worker.service.ts:98-145`, impact: +500ms p50, +1000ms p99 (100% of budget)
- Fix: PostgreSQL trigger + `LISTEN farm_outbox_new` in worker, cron remains as 5s safety net. Latency drops from mean 500ms to mean ~5ms. **~30 LoC + 1 migration = biggest single win.**

**P-C2 — Per-cycle double `COUNT(*)` burns 172k queries/day/replica forever**
- `outbox-worker.service.ts:108-121`, impact: 2 queries/sec/replica × 10 replicas = 1.7M idle queries/day
- Fix: refresh gauges every 10-30 cycles, not every cycle; combine into one grouped query. Combined with P-C1 → ~99% idle DB load reduction

**P-C3 — JSONB payload double-serialization + 2× memory copy**
- `outbox-publisher.service.ts:65-73`, `outbox-worker.service.ts:147-156`
- 3 serializations per event: spread copy → TypeORM JSON → NATS codec. ~1-3 KB × 2 copies = 6-12 KB per event
- Fix: drop `{...event}` spread (manager.save doesn't pollute); cap `BatchCreated.tankIds` at 100; long-term store `bytea` wire-ready bytes

### HIGH

- **P-H1** Worker has no row lease → multi-replica N² duplication (confirmation of arch C2, perf angle). Fix: `FOR UPDATE SKIP LOCKED` shards work between replicas; throughput scales linearly
- **P-H2** Per-row serial `await publishOne(row)` — batch size 100 × 5ms = **500ms per batch serial**. Fix: `pLimit(20)` bounded concurrency → throughput 200 → 4000 events/sec/replica
- **P-H3** `create-batch.handler.ts` N+1: 3-5× per-location query inside transaction, holds locks. Fix: bulk-fetch all tanks + tankBatches in 2 queries before loop. Latency 350ms → 80ms (4×)
- **P-H4** `record-mortality.handler.ts` acquires 4 pessimistic locks sequentially = 4 RTTs minimum. Fix: acquire Batch + TankBatch via single CTE
- **P-H5** Histogram `service` label lacks `event_type` — no per-type p99 visibility. Fix: add label (~75 series total, fine)
- **P-H6** `farmWsBroadcasts` has unbounded `tenant` cardinality. 10k tenants × 10 events = 10k series × 150B = 1.5 MB/pod per metric. Fix: drop tenant label OR bucket hash

### MEDIUM

- **P-M1** `manager.save` instead of `manager.insert` — validator + change detection + RETURNING hydration wasted. Fix: `insert` (~1-2ms/event saved)
- **P-M2** Worker UPDATE is separate round-trip from publish — batch successful IDs into one `UPDATE WHERE id IN (...)`
- **P-M3** `deductFeedInventory` pessimistic lock serializes ALL feedings on same feed type. Fix: atomic `UPDATE-RETURNING` with `SKIP LOCKED`. Throughput = sequential → parallel per lot
- **P-M4** Bridge `for await` has no backpressure → memory growth on burst. Future: JetStream pull consumer
- **P-M5** Frontend invalidation explosion: single `MortalityRecorded` refetches **5 list queries**; 15 records/30s = 75 GraphQL queries. **Fix: 250ms debounce + collapse invalidations = 10× reduction**
- **P-M6** **CORRECTNESS ISSUE (not just perf):** bridge uses queue group `gateway-farm` → each NATS msg delivered to ONE pod → Socket.IO rooms are pod-local → 80% of clients miss every event on 5-pod deployment. **No Redis adapter wired.** Fix: add `@socket.io/redis-adapter` OR remove queue group. **BLOCKS horizontal scaling.**
- **P-M7** 10 separate subject subscriptions vs 1 wildcard (minor)
- **P-M8** Worker transaction atomicity: crash between `publish` and `update` → republish (mitigated by NATS dedup but noisy)

### LOW
P-L1 (dead DI repositories), P-L2 (re-fetch TankBatch twice in transfer), P-L3 (harvest lot sequence uses table lock), P-L4 (bridge warn log volume amplification), P-L5 (debug log allocation per success), P-L6 (`clients` Map duplicates Socket.IO `sockets.sockets`), P-L7 (status transition validation inside TX)

### Scalability at target (10 replicas / 10k tenants / 100k clients)
Without fixes: **UNUSABLE**. Requires:
- P-C1 (LISTEN/NOTIFY)
- P-H1 (SKIP LOCKED)
- P-M6 (Redis adapter — CORRECTNESS)
- P-H6 (drop tenant label)
- P-M5 (debounce)
Even fixed, 1000 events/sec × 100k clients = 100M emits/sec requires tenant-sharded gateway pods OR per-resource room granularity (Phase E scope).

### Top 5 optimizations by ROI

| # | Finding | Effort | Impact |
|---|---|---|---|
| 1 | **P-C1 LISTEN/NOTIFY** replace 1s cron | 2h | **-500ms p50**, -1000ms p99 on EVERY event. 50% of budget recovered |
| 2 | **P-M6 Socket.IO Redis adapter** | 1h | **CORRECTNESS** — unblocks multi-pod |
| 3 | **P-H1+P-H2+P-M2** worker SKIP LOCKED + bounded concurrency + batch UPDATE | 3h | 20× throughput (200 → 4000 events/s/replica), eliminates double-publish |
| 4 | **P-M5** frontend debounce | 1h | 10× refetch reduction under burst |
| 5 | **P-H3** create-batch bulk-fetch | 2h | 4× faster (350 → 80ms), frees 270ms budget |

After these 5 (~9 hours), pipeline should hit ≤500ms p50.

---

## Critical Issues for Phase 3 Context

### Deployment blockers (must fix before any release)
1. **CR-1 + CR-2** (security) — cross-tenant event fan-out
2. **P-M6** (perf + correctness) — no Socket.IO Redis adapter = multi-pod broken
3. **Arch C1** (Phase 1) — JetStream `expect: { lastMsgID }` fails every post-first publish
4. **Arch C2 / P-H1** — multi-replica worker double-publish

### High-priority fixes (sprint)
1. **P-C1** LISTEN/NOTIFY (biggest single latency win)
2. **H-1** (sec) JWT type=access discriminator
3. **H-3** (sec) zod schema validation at bridge
4. **H-4** (sec) CORS production hard-fail
5. **P-H3** create-batch bulk-fetch
6. **P-M5** frontend debounce

### Testing gaps (Phase 3 emphasis)
- **Arch R4** (Phase 1): no end-to-end contract test across 8-step pipeline
- **CR-1**: no negative test verifying cross-tenant spoofing is blocked
- **P-M6**: no multi-pod integration test verifying Redis adapter is wired
- **C1 arch**: no integration test asserting successful multi-publish under JetStream

### Documentation gaps (Phase 3 emphasis)
- Tenant isolation trust chain (authoritative doc)
- Contract versioning policy
- Dead-letter recovery runbook
- Incident playbook for "events not appearing"
