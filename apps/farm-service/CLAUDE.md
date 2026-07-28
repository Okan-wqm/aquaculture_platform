# farm-service — CLAUDE.md (domain context)

> Root rules in `/CLAUDE.md` already apply (always loaded). This file adds ONLY farm-domain facts.

Farm, pond, batch, feed, harvest, water quality, equipment, tasks. Schema: `farm` (tenant-scoped — per-tenant tables are cloned into `tenant_<uuid>` by `TenantSchemaSyncService`).

## Schema (per-table, not per-service)
- Per-tenant tables OMIT `schema:` (e.g. `farms`, `ponds`, `tasks`) — search_path routes them at runtime.
- Cross-tenant tables KEEP `schema: 'farm'`. The authoritative set is farm's `MODULE_SCHEMAS[].infrastructureTables` in `libs/backend-common/src/database/schema-manager.service.ts`: <!-- infra-tables:farm -->`migrations`, `farm_outbox`, `outbox_events`, `inbox_messages`, `event_dlq`, `tenant_erasure_audit`, `farm_audit_logs`, `tenant_erasure_target_proofs`<!-- /infra-tables -->. That list is proven against the registry by `tests/invariants/nested-steering-parity.spec.ts` — edit the registry, never this copy. (`farm_outbox` is a legacy registry alias; the live entity `outbox/farm-outbox.entity.ts` declares `name: 'outbox_events'`.)
- farm-service OWNS the platform schema-routing architecture spec: `apps/farm-service/src/__tests__/e2e/tenant-schema-routing.architecture.spec.ts`. It no longer carries a hand-copied allowlist: the permitted `schema:'farm'` set is DERIVED from `MODULE_SCHEMAS['farm'].infrastructureTables`, so the spec and tenant provisioning cannot disagree (this closed ORPHAN-MEDIUM-118 — the stale copy named only the outbox and reported `farm_audit_logs` + `tenant_erasure_audit` as violations). The inverse direction (cross-tenant tables MUST carry `schema:`) is guarded by `e2e/tests/integration/schema-invariants.spec.ts` B.1/B.2, which runs per PR in the `schema-invariants` job of `db-migration-check.yml` — until 2026-07-28 that spec appeared in the workflow's `paths:` filters only, so it triggered a run and was never executed (FARM-MEDIUM-303).

## Domain invariants
- Tank over-capacity stocking is LEGITIMATE via admin-override + audit log (`apps/farm-service/src/tank/services/tank-capacity.service.ts`) — it is the correct shape, not a bug to "fix" with a hard cap.
- Identity / CQRS / transaction SSoTs are guarded by the farm invariant family in `tests/invariants/`: `farm-service-tenant-isolation.spec.ts`, `farm-identity-ssot.spec.ts`, `farm-rest-cqrs-ssot.spec.ts`, `farm-batch-policy-transaction-ssot.spec.ts`, `farm-site-system-eventing-transaction-ssot.spec.ts`, `farm-graphql-fe-be-parity.spec.ts`, `farm-service-migration-array-completeness.spec.ts`.

## Enforcement
Boot: `SchemaDriftValidator`. CI: the `tests/invariants/` family above runs per PR through the `invariants` project's `test` target. `tenant-schema-routing.architecture.spec.ts` runs through farm-service's **`test:integration`** target — which was invoked by nothing until 2026-07-27, so that spec (and the other twelve in the lane) had never executed; the lane is wired into `ci-affected.yml` now and `tests/invariants/test-target-ci-reachability.spec.ts` keeps it that way.
