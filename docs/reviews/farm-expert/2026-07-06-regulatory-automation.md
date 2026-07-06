# Farm — Mattilsynet automated-reporting workstream findings — 2026-07-06

Workstream: `docs/plans/2026-07-06-mattilsynet-automated-reporting/PLAN.md` (RPT register).
Findings discovered en route that are tracked in the canonical registry get their canonical
`FARM-*` IDs here; the plan's RPT-* rows cross-reference them.

## FARM-HIGH-145 — permission-matrix invariant red on main: two shipped operations unclassified (plan ref RPT-020)

`apps/farm-service/src/common/authz/__tests__/permission-matrix.spec.ts` was failing on main:

- `recordWaterTemperature` (@Mutation, `water-quality/water-quality.resolver.ts` — the manual
  water-temperature entry feeding the feed-rate calculation, Phase 2a) carries
  `@Roles(TENANT_ADMIN, MODULE_MANAGER)` in source but had no `MUTATION_ROLES` entry.
- `batchTraceability` (@Query, `batch/resolvers/batch.resolver.ts` — Phase 6 lifecycle
  traceability report) carries `@Roles(TENANT_ADMIN, MODULE_MANAGER, MODULE_USER)` but had no
  `QUERY_ROLES` entry.

Impact: beyond the red invariant suite (which masks any new regression in the same suite), the
fail-closed `PermissionMatrixGuard` rejects unclassified operations at runtime — both features
are broken in production for every role.

Root cause: the operations shipped (PR #873/#879 era) without the mandatory matrix entry; the
invariant that exists precisely to catch this was red and tolerated.

Fix (this cycle): `permission-matrix.ts` gains both entries mirroring the source `@Roles`
exactly; suite green. No behavioural widening — the matrix now states what source already
declared.

Verification: `nx test farm-service` — 194 suites / 1169 tests green (was 1 suite red).
