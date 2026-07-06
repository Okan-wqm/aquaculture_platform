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

## FARM-HIGH-146 — no official-schema gate before Mattilsynet REST submissions (plan RPT-017 in-repo half, Phase 0)

Nothing enforced the regulator's wire format: resolvers assembled payloads and sent them
straight to the network; a schema-invalid report failed only after a PENDING row existed and a
regulator round-trip. Phase 0 of the automated-reporting plan lands the contract layer: the five
official JSON Schemas in-repo (`regulatory/schemas/official/`), a `ValidatedPayload<T>` branded
type whose only producer is `MattilsynetSchemaValidatorService.validate()`, all five
`MattilsynetApiService.submit*` signatures requiring the brand (skipping validation is a compile
error), pre-persist validation in the resolvers (invalid payloads return field-level
`valideringsfeil` and never create a PENDING row), and a golden-fixture contract suite as the
two-way TS-interface ↔ JSON-Schema drift trap. The live-swagger diff (x-verified flip) remains
operator-gated — the schemas are transcribed from `docs/integrations/mattilsynet-reporting-api.md`.

## FARM-HIGH-147 — no server-side report assembly: prefill was client-side tank math (plan RPT-002 + RPT-012, Phase 1a)

The report forms computed their own "Load from System" values in the browser from
`useTanksList` batch metrics — biomass by species from tank cards, mortality lumped under
"Unknown" (no cause breakdown), and feed estimated as `daily rate × 30` instead of the real
ledger. The dormant `BiomassCalculatorService.getSiteBiomassReport` (species-aware, N+1-free)
had no caller, and no aggregation existed for mortality-by-cause (despite the purpose-built
`(tenantId, cause)` index), cross-site transfers, or site feed consumption.

Phase 1a fix: server-side assembly — `ReportAssemblyService` + `BiomassReportAssembler` +
`reportPrefill` GraphQL query with per-field provenance (RECORDS / SENSOR / MANUAL_REQUIRED);
new CQRS queries `GetMortalityByCauseQuery`, `GetTransfersSummaryQuery`,
`GetSiteFeedConsumptionQuery`; `BiomassCalculatorService` wired as THE standing-stock source
(RPT-012 dedup verdict). Frontend: `useReportPrefill` + `ProvenanceBadge`;
`BiomassReportTab` client aggregation **deleted** (guarded by a stay-deleted spec) and the
wizard seeds every section from the assembled draft. Remaining report types' assemblers are
Phase 1b/2 of the tracked plan.
