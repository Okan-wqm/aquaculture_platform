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

## FARM-HIGH-148 — the five Mattilsynet REST report types had no server-side assembly (plan Phase 1b)

Only the biomass draft assembled server-side after Phase 1a; sea lice, settefisk, rensefisk and
both slakt reports still computed nothing — operators typed every value, including data the
platform owns (per-tank stock and weights, monthly mortality/cull splits, cleaner-fish ledger
movements, weekly harvest totals, planned-harvest weekday quantities, site water temperature).

Phase 1b fix: assemblers for all five REST types (`regulatory/assembly/assemblers/`), a shared
`period.util.ts` (month + ISO-week math, one implementation), and provenance discipline —
values the platform lacks are flagged MANUAL_REQUIRED (blocking when the official schema
requires them: lice counts, quality-class splits, godkjenningsnummer) and never guessed.
`WaterTemperatureService` gains `getSiteCurrentTemperature` + provenance fields
(measuredAt/sensorId) — the ONE temperature path now serves feed-rate AND reporting.
Frontend: SeaLice seeds sjøtemperatur from the draft with a sensor/records badge (the stale
"until sensor integration is enabled" copy is gone); Smolt's Load-from-System now consumes the
server draft instead of client tank math (guard spec keeps both wired). CleanerFish/Slaughter
tabs consume their assemblers in the Phase 4 review-and-approve rework — building interim
seeding UI there would duplicate structures Phase 4 replaces (dedup principle).

## FARM-HIGH-149 — regulatory identity + operational capture entities missing (plan Phase 2, umbrella)

The remaining data the regulator requires has no platform home: official species codes
(artskode), site lokalitetsnummer as an intrinsic Site attribute, lice counts, per-application
treatments, welfare scores, escape incidents, the slaughter-facility catalog, external-transfer
identity, and the temperature period series. Phase 2 of the automated-reporting plan closes
these one sub-slice at a time; every sub-slice commit carries this finding's trailer, and the
plan's RPT-004..016 rows track the individual verdicts.

## FARM-HIGH-150 — create-site DTO uses @Min/@Max without importing them (schema-registration build-break)

Found while running `tsc --noEmit -p apps/farm-service/tsconfig.app.json` during the Phase 5
biomass-Altinn frontend slice. The Phase 2b-ii site regulatory-identity slice added the 5-digit
`lokalitetsnummer` field with `@IsInt @Min(10000) @Max(99999)`, but the class-validator import
block only pulled `IsInt` — `Min` and `Max` were never imported. At class-decoration time the
decorators evaluate to `undefined` and the module throws when it loads during GraphQL schema
build, so the service cannot boot. The test suite masked it (vitest/jest transpile without a full
type-check and no spec imports the DTO); `tsc` is the gate that caught it. Fix: add `Min, Max` to
the import. Sibling DTOs (`update-site.input.ts`, `site-contact.input.ts`) already import what
they use.

## FARM-HIGH-151 — the three varsling report types had no server-side assembly (plan Phase 4, umbrella)

Escape (rømming), welfare and disease are event-triggered varsling reports; unlike the period-based
REST types they had no assembler, so every field was manual. Phase 4 lands
`EscapeReportAssembler`, `WelfareReportAssembler` and `DiseaseReportAssembler`
(`regulatory/assembly/assemblers/`), each assembling `(tenantId, siteId)` from the recorded
incident/assessment/event with the same RECORDS / MANUAL_REQUIRED provenance discipline, wired into
`ReportAssemblyService` dispatch (now exhaustive across all nine `ReportPrefillType` values) and
surfaced on the three tabs as read-only review cards. What the entities cannot express stays
blocking MANUAL_REQUIRED; a missing source record blocks the whole draft (fail-closed).

## FARM-MEDIUM-152 — disease outbreaks have no dedicated operational entity (interim health_events source)

Unlike escape and welfare, disease has no operational entity — `DiseaseReportAssembler` reads the
generic `health_events` ledger (latest `disease_outbreak`) as an interim source, which cannot
express the regulator's A/C/F disease list, suspected/confirmed status, affected count or vet
notification (all kept blocking MANUAL_REQUIRED). Root solution: a dedicated disease-outbreak entity
carrying the varsling wire fields, at which point the assembler moves those fields to RECORDS.

## FARM-MEDIUM-153 — CleanerFish client aggregation is richer than the rensefisk assembler (dedup blocked)

The CleanerFish tab's `aggregateCleanerFishFromTanks` reads `tank.batchMetrics.cleanerFishDetails`
and is richer than the rensefisk assembler (4 blocking MANUAL_REQUIRED / 1 RECORDS). Deleting the
client math in favour of the server draft now would regress the operator UX, so the dedup is blocked
until the rensefisk assembler reaches RECORDS coverage for the nine uttak causes.

## FARM-MEDIUM-154 — SourceRecordsDrawer deep-link is blocked on a sourceQuery→route map

The provenance badges carry a `sourceQuery` string, but it does not map cleanly to farm-module routes
(mortality is per-batch with no site-wide page; lice-counts has no dedicated route), so a one-click
deep-link from a RECORDS badge to its source record needs a deliberate sourceQuery→route UX design
first. Until then corrections are routed by prose ("corrections go to Fish Health").

## FARM-HIGH-155 — disease assembler queried non-existent health_events columns + dropped batch-scoped outbreaks (pre-merge review)

The disease assembler selected `he.diagnosis` and `he."affectedPercent"` — neither is a column on
`health_events` (real: `diseaseName`; the percentage is nested in the `affectedPopulation` jsonb) —
so every `DISEASE_OUTBREAK` prefill threw Postgres `42703` at plan time, and the fail-closed
"no event" path never ran. Site scope also used an INNER JOIN on the nullable `he.tankId`, silently
dropping batch-scoped outbreaks. The mocked London spec returned fabricated column keys and hid the
crash. Fix: real columns + `affectedPopulation ->> 'affectedPercent'`; batch-scoped `EXISTS` through
`tank_batches` (batchId is NOT NULL); deterministic `ORDER BY eventDate DESC, createdAt DESC`; a
SQL-capturing spec guard that pins the real columns and rejects the phantom identifiers.

## FARM-MEDIUM-156 — biomass slaughter section SQL is an illegal aggregate (42803)

`BiomassReportAssembler.querySlaughter` selected `COALESCE(s."officialCode", s.code)` while grouping
only by `s.code` — `officialCode` is neither grouped nor functionally dependent on the non-PK
`s.code`, so Postgres rejects it with `42803`, 500-ing the monthly biomass slaughter section. Fix:
add `s."officialCode"` to the GROUP BY (unchanged cardinality since `(tenantId, code)` is unique).

## FARM-MEDIUM-157 — report assemblers have no real-database integration coverage (systemic root)

The assembler London specs mock `queryRunner.query`, so raw-SQL column-name drift (FARM-HIGH-155) and
GROUP BY aggregation errors (FARM-MEDIUM-156) are invisible to the unit suite and only surface at
runtime. Interim detectable guard landed: the disease spec captures the emitted SQL and pins the real
columns / batch-scoped EXISTS / tiebreak. Durable close: a `bootPostgresContainer` harness (pattern:
`apps/farm-service/src/__tests__/e2e/*.postgres.spec.ts`) that runs each assembler against a migrated
schema with seeded rows.

## FARM-MEDIUM-158 — artskode COALESCE can launder an internal species code into the official FAO field

Across the assembler family, artskode is sourced as `COALESCE(s."officialCode", s.code)`; when
`officialCode` is unset an internal code that passes the format gate is surfaced as the official
Mattilsynet FAO artskode with trusted RECORDS provenance. The official wire field should come solely
from `species.officialCode` (the artskode SSoT added in migration `1802500000000`) and emit blocking
MANUAL_REQUIRED when unset. Family-wide fix deferred to avoid a one-off escape divergence.
