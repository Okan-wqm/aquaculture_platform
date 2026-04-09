# Package 09: platform-monetary-config-resilience

## Metadata
Status: IMPLEMENTED
Estimated Tokens: 22K
Priority: MEDIUM
Security-Sensitive: yes
Parallelizable: yes
Prerequisites: none

## Closing-Findings
Closing-Findings: [PLAT-MEDIUM-001, PLAT-MEDIUM-002, PLAT-MEDIUM-003, PLAT-MEDIUM-004, PLAT-MEDIUM-005, PLAT-MEDIUM-006, PLAT-MEDIUM-007, PLAT-MEDIUM-008, PLAT-MEDIUM-009]

## Source-Reviews
- docs/reviews/orchestrator/2026-04-09-full-platform-audit.md
- docs/reviews/platform-services/2026-04-05-s2-high-findings.md

## Context
Nine platform service findings span billing precision, DLQ access control, rate limiting, water chemistry units, config caching, event projection safety, and floating promises. They touch billing-service, alert-engine, config-service, and shared libs. Grouped because they are all independent point fixes in platform-layer services with no cross-dependencies.

## Findings

**PLAT-MEDIUM-001 — Inconsistent safeAdd implementation**
`libs/backend-common` has a `safeAdd()` utility that uses `Number()` addition instead of arbitrary-precision arithmetic. Used in billing and metering calculations. Replace with `Decimal.js` or `Big.js` for financial math.

**PLAT-MEDIUM-002 — roundCurrency uses Math.round**
`roundCurrency()` uses `Math.round(amount * 100) / 100` which has floating-point edge cases (e.g., `1.005 * 100 = 100.49999...` rounds to 1.00 instead of 1.01). Use `Number(amount.toFixed(2))` or better, string-based rounding.

**PLAT-MEDIUM-003 — Stripe secret loaded from process.env directly**
`billing-service` reads `STRIPE_SECRET_KEY` via `process.env.STRIPE_SECRET_KEY` instead of NestJS `ConfigService`. Bypasses config validation and makes testing harder.

**PLAT-MEDIUM-004 — DLQ has no RBAC**
The dead-letter queue management endpoints (retry, purge) have no role-based access control. Any authenticated user with API access can replay or delete DLQ messages. Add `@Roles('SUPER_ADMIN')` guard.

**PLAT-MEDIUM-005 — No Retry-After header on rate-limited responses**
When the API rate limiter returns 429, it does not include a `Retry-After` header. Clients cannot implement exponential backoff correctly. Add `Retry-After: {seconds}` header to 429 responses.

**PLAT-MEDIUM-006 — Ion balance calculation uses % instead of meq/L**
Water quality ion balance should use milliequivalents per liter (meq/L) for cation/anion balance, not simple percentage. The current calculation can give misleading results for solutions with mixed-valence ions.

**PLAT-MEDIUM-007 — Config cache is local-only (per-pod)**
`config-service` caches tenant configurations in a per-process `Map`. In multi-pod deployments, config updates on one pod are not visible to others until cache TTL expires. Use Redis-backed cache or pub/sub invalidation.

**PLAT-MEDIUM-008 — Event projection has no safe-tail cursor**
The event projection service processes events without a persistent "last processed" cursor that survives restarts. On crash recovery, it replays from the beginning, causing duplicate projections. Add a persistent cursor (database row or Redis key).

**PLAT-MEDIUM-009 — Floating promise on eventBus.publish**
`eventBus.publish()` calls in multiple services are not awaited. If the NATS connection is down, the promise rejects silently. Per CLAUDE.md, all async calls must be awaited.

## Affected Files
- libs/backend-common/src/utils/safe-math.ts (or equivalent)
- apps/billing-service/src/billing/services/ (Stripe integration)
- libs/backend-common/src/middleware/ (rate limiter or exception filter)
- apps/alert-engine/src/ (DLQ endpoints)
- libs/aquaculture-engines/src/ (water quality ion balance calculation)
- apps/config-service/src/configuration/services/configuration.service.ts
- libs/backend-common/src/event-bus/ (projection cursor, floating promise)

## Dependencies
None. These are independent point fixes across platform services.

## Atomic Commit Plan
```
fix(platform): use Decimal for monetary math, load Stripe via ConfigService, add DLQ RBAC, Retry-After header, meq/L ion balance, Redis config cache, projection cursor, await eventBus

Nine platform service fixes:
- Replace Number-based safeAdd/roundCurrency with Decimal.js arithmetic
- Load STRIPE_SECRET_KEY via ConfigService, not process.env
- Add @Roles('SUPER_ADMIN') to DLQ management endpoints
- Add Retry-After header to 429 rate-limit responses
- Fix ion balance calculation to use meq/L units
- Replace in-memory config cache with Redis-backed cache
- Add persistent cursor to event projection service
- Await all eventBus.publish() calls

Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#PLAT-MEDIUM-001
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#PLAT-MEDIUM-002
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#PLAT-MEDIUM-003
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#PLAT-MEDIUM-004
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#PLAT-MEDIUM-005
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#PLAT-MEDIUM-006
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#PLAT-MEDIUM-007
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#PLAT-MEDIUM-008
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#PLAT-MEDIUM-009
Plan: docs/plans/2026-04-09-medium-fixes/packages/09-platform-monetary-config-resilience.md
```

## Test Plan
- Unit test: safeAdd(0.1, 0.2) === "0.30" (string result)
- Unit test: roundCurrency(1.005) === "1.01"
- Unit test: billing service reads Stripe key from ConfigService (mock ConfigService)
- Unit test: DLQ endpoints return 403 for non-SUPER_ADMIN
- Unit test: 429 response includes Retry-After header
- Unit test: ion balance for mixed-valence solution uses meq/L
- Integration test: config update on pod A visible on pod B via Redis
- Unit test: projection resumes from last cursor after restart
- Lint: no unhandled eventBus.publish() calls (async/await required)

## Verification Command
`npx tsc --noEmit -p libs/backend-common/tsconfig.json && npx tsc --noEmit -p apps/billing-service/tsconfig.json && npx tsc --noEmit -p apps/config-service/tsconfig.json && npx jest --testPathPattern="(libs/backend-common|apps/billing-service|apps/config-service|apps/alert-engine)" --coverage=false`
[Dispatch: test-runner]

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes
