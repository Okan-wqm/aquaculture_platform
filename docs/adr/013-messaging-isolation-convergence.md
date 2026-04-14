# ADR-013: Messaging Service Isolation Convergence

**Status:** Accepted
**Date:** 2026-04-14
**Deciders:** platform team
**Related:** ADR-011 (Schema Ownership Model), ADR-012 (Schema Drift Prevention)

## Context

The messaging service was the only platform service deviating from the
established multi-tenant isolation pattern (ADR-011). Every other
backend service uses **schema-decorated entities + RLS as primary
isolation + search_path as defense-in-depth**:

| Layer | Mechanism | Strength |
|---|---|---|
| Primary | Row-Level Security policies on source schema | Database engine enforces; FORCE makes table owner subject to policy too |
| Defense-in-depth | search_path mutation per request via TenantSchemaMiddleware | Catches accidental unqualified queries |
| Schema decoration | `@Entity('x', { schema: 'svc' })` | TypeORM emits qualified SQL; SchemaDriftValidator passes |

Messaging used **search_path-only isolation**:
- Entities undecorated (`@Entity('channels')`)
- TypeORM emitted unqualified SQL → resolved to `tenant_<uuid>.channels`
  via per-request search_path mutation
- ZERO RLS policies on `messaging.*` source schema (verified via grep
  in P0 audit — no `CREATE POLICY` statements anywhere in
  `apps/messaging-service/src/migrations/`)

This mode worked **as long as TenantSchemaMiddleware ran on every
query path**. Any code path that bypassed the middleware (background
worker, raw connection use, future code change forgetting the
middleware import) leaked across tenants silently.

The 2026-04-14 e2e TENANT_ISOLATION test failure surfaced this:
- Immediate cause: `column "channel_lastmessageat" does not exist`
  (PostgreSQL identifier folding bug at handler:74 — fixed in P1)
- Root cause: `SchemaDriftValidator[messaging]` reported 15 entity
  drift violations at every cold start, indicating mismatch between
  TypeORM metadata and physical schema location

The drift violations were the symptom of messaging's deviation. Fixing
them required architectural convergence to the platform-standard
isolation model.

## Decision

**Migrate messaging to the ADR-011 standard isolation pattern (the
"farm model"):**

1. Decorate every messaging `@Entity()` with `{ schema: 'messaging' }` —
   TypeORM generates `messaging.<table>` qualified SQL
2. Install `tenant_isolation_policy` on every tenant-scoped messaging
   table via the shared `applyTenantRlsToSchema` helper
3. Wire `RlsConnectionBootstrap` (already auto-registered via
   `RlsModule.forRoot`) for `app.current_tenant` GUC injection on
   every connection checkout
4. Add `tenantId uuid NOT NULL` column to the 7 child tables that
   lacked one (P3 migration)
5. Consolidate per-tenant data (`tenant_<uuid>.<table>` →
   `messaging.<table>`) so decorated entities have data to query
   (P6 — operator-gated migration)
6. Continue running `TenantRlsSyncService` to mirror policies onto
   any per-tenant schema clones (defense-in-depth; not load-bearing
   any longer)
7. Migration runner factory `createMigrationRunnerService('messaging')`
   replaces TypeORM's built-in `migrationsRun: true` for search_path
   pinning consistency

## Rationale

### Why converge instead of carve out an exception in ADR-011

ADR-011's "every entity must declare schema" rule exists because
unqualified entities silently land in `public` and break RLS bootstrap
across the platform. The 2026-04-14 production audit found 14 tables
in `public` because of this exact failure mode (closed in earlier
phases of the same plan). Allowing messaging an exception:

- Permanent special case in CI (`schema-invariants.spec.ts` exemption)
- `SchemaDriftValidator[messaging]` permanently noisy (alert fatigue)
- New developers might apply the messaging pattern elsewhere by analogy
- Architectural complexity scales linearly with number of exceptions
- Lone exception is harder to maintain than a uniform rule

The convergence cost (data consolidation migration, entity decoration)
is one-time. The exception cost is permanent.

### Why RLS is load-bearing (not just defense-in-depth)

PostgreSQL RLS is a database engine guarantee — no application code
path can bypass it without explicit `app.bypass_rls = 'on'` GUC,
which is auditable and scoped to a single transaction.

Search-path-only isolation depends on every code path running the
middleware:
- HTTP requests: covered by NestJS middleware chain
- GraphQL field resolvers: same as HTTP
- WebSocket handlers: depends on connection setup
- Background jobs (cron, NATS subscribers): often NOT covered
- Test fixtures: often setup outside middleware
- Direct `dataSource.query()` calls in services: only covered if
  someone remembered to set search_path explicitly (verified zero
  uses of `SET search_path` in messaging non-migration code)

The P10 audit found 2 CRITICAL background workers that operate
cross-tenant via direct SQL (embedding cron, knowledge-extraction
cron). Under RLS, these MUST wrap in `BypassRlsService.withBypass()`
or they silently produce empty results. Tracked as CRITICAL-MSG-002
and CRITICAL-MSG-003 — must land before P4 reaches production.

### Why keep the per-tenant schema clones (defense-in-depth, not removal)

`TenantSchemaSyncService` continues to maintain `tenant_<uuid>.*`
schemas via `CREATE TABLE LIKE INCLUDING ALL`. After P7 entity
decoration, TypeORM no longer queries them — they're vestigial.

Options considered:
- (A) Drop tenant clones (P9 of plan; cleanup)
- (B) Keep as defense-in-depth (current state post-P7)

Decision: **keep them** for the foreseeable future:
- Provide a fallback if RLS is somehow disabled in an emergency
- Allow per-tenant operations (e.g. tenant-specific cleanup) to
  target a specific schema explicitly without RLS interference
- Removal cost (P9 migration) is higher than maintenance cost
- Future ADR may revisit when scale considerations (10K+ tenants
  × 17 tables = 170K+ catalog objects) become measurable

The P9 phase exists in the plan as OPTIONAL cleanup, not required.

## Consequences

### Positive

- Messaging now matches every other service's isolation model — one
  pattern across 12 services
- RLS engine-level guarantee replaces the fragile "remember to set
  search_path" contract
- `SchemaDriftValidator[messaging]` reports 0 violations on cold start
- `schema-invariants.spec.ts` CI test asserts the 17 table layout
- Future messaging entities are forced to declare `schema: 'messaging'`
  by the existing CI invariant + (future) ESLint rule
- 7 child tables now have explicit `tenantId` with NOT NULL + index,
  improving query plans and audit observability

### Negative / risks

- Two CRITICAL background workers (embedding, knowledge-extraction)
  break silently if P4 deploys before bypass wraps land. Mitigated
  by audit document + tracked findings + recommended deploy order.
- P6 data consolidation migration is destructive and requires pg_dump
  snapshot. Operator must execute under maintenance window with the
  documented runbook.
- P7 entity decoration requires P6 to have run in production —
  decorated entities query `messaging.*` directly; if data is still
  in `tenant_<uuid>.*`, queries return empty. Coordinated deploy
  ordering is documented in `docs/runbooks/messaging-rls-rollout.md`.
- Migration runner switch (`createMigrationRunnerService`) means
  TypeORM's `migrationsRun: true` is now `false`. `DATABASE_MIGRATIONS_RUN`
  env var still hard-fails production when `false`.

### Neutral

- Per-tenant schemas (`tenant_<uuid>.messaging_*`) still exist as
  defense-in-depth. Disk space + catalog object count unchanged.

## Implementation phases (executed 2026-04-14)

| Phase | Commit | Description |
|---|---|---|
| P0 | (audit-only) | Pre-flight audit at `docs/plans/2026-04-14-messaging-isolation/pre-flight-audit.md` |
| P1 | d93cc6a4 | Quote ORDER BY alias to fix immediate `column does not exist` bug |
| P2 | c156d8cb | Wire `createMigrationRunnerService('messaging')` + CLI data-source |
| P3 | af9516e3 | Add `tenantId` column + backfill on 7 child tables |
| P4 | e88f132f | Install `tenant_isolation_policy` via `applyTenantRlsToSchema` |
| P5 | 205f93a8 | Sync `RlsModule.forRoot` excludeTables with P4 migration |
| P6 | 08db0f7b | Write data-consolidation migration (CODE ONLY — operator-gated execution) |
| P7 | f11491d2 | Decorate all 17 entities with `{ schema: 'messaging' }` |
| P8 | e94e1368 | Extend `schema-invariants.spec.ts` with 17 messaging table assertions |
| P10 | dbe56377 | Handler audit — 2 CRITICAL bypass gaps documented |
| P12 | (this commit) | ADR-013 + runbook |

## References

- ADR-011 (Schema Ownership Model)
- ADR-012 (Schema Drift Prevention)
- Plan: `/root/.claude/plans/polished-brewing-knuth.md`
- Pre-flight audit: `docs/plans/2026-04-14-messaging-isolation/pre-flight-audit.md`
- Handler audit: `docs/plans/2026-04-14-messaging-isolation/p10-handler-audit.md`
- Runbook: `docs/runbooks/messaging-rls-rollout.md`
- Closes: `docs/reviews/messaging-expert/2026-04-14-tenant-isolation-violation-e2e.md#CRITICAL-MSG-001`
