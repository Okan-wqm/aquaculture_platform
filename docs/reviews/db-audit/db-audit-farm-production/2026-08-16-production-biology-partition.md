# farm-service production-biology partition — database E2E audit — 2026-08-16

**Agent:** `db-audit-farm-production` · **Mode:** CATCHER (read-only) · **Lane:** farm
**Cycle:** `2026-08-16-farm-mobile-agent-audit` · **Verdict:** BLOCK
**Findings surviving verification:** 12 (CRITICAL 0 · HIGH 0 · MEDIUM 9 · LOW 3)

> Produced by a 27-agent audit workflow. Every CRITICAL/HIGH claim was handed to an
> independent verifier instructed to **refute** it by reopening each cited line;
> claims that could not be defended were dropped into the Refuted section below.
> MEDIUM/LOW claims did not enter the verify stage and carry the raising agent's
> confidence only.
>
> **Finding IDs** use the `DB-FARMPROD-*` prefix this agent's contract in
> `.claude/shared/output-format.md` assigns it. That prefix is **rejected** by the
> `id` pattern in `docs/reviews/_registry/findings.jsonl.schema.json`, so these findings
> cannot be registered at all — see `PROC-MEDIUM-016` in the cycle report.

## Scope

Read the full entity set of the farm-production-biology partition in
/home/user/aquaculture_platform/apps/farm-service/src: batch/ (batch.entity.ts,
tank-batch.entity.ts, tank-allocation.entity.ts, tank-operation.entity.ts,
mortality-record.entity.ts, batch-location.entity.ts, batch-document/feed-assignment entities,
services/tank-batch.service.ts, services/batch.service.ts,
handlers/{create-batch,allocate-to-tank,record-mortality,record-cull,transfer-batch}.handler.ts,
controllers/batch.controller.ts, dataloaders/batch-location.dataloader.ts,
query-handlers/get-batch-traceability.handler.ts), tank/ (tank.entity.ts,
services/tank-capacity.service.ts, resolvers/tank.resolver.ts), growth/
(growth-measurement.entity.ts, resolvers/growth.resolver.ts, `handlers/*`,
services/fcr-calculation.service.ts), fish-health/ (health-event, lice-count, welfare-assessment,
escape-incident, treatment-application, farm-incident-media entities; `services/*`;
resolvers/field-capture.resolver.ts), water-quality/ (water-quality-measurement, parameter-config,
param-equipment, sensor-temperature-{latest,daily} entities; water-quality.service.ts), harvest/
(harvest-record.entity.ts, dto/{create,update}-harvest-record.input.ts,
handlers/{create,update,list}-harvest-record.handler.ts, resolvers/harvest.resolver.ts),
species/species.entity.ts, plus equipment/dataloaders/feed-selection.dataloader.ts,
farm-stock/farm-stock-projection.service.ts,
events/listeners/sensor-temperature-projection.listener.ts,
regulatory/assembly/assemblers/{lakselus,escape,welfare}.assembler.ts, and farm migrations
1800000000000-Baseline, 1802000000000-AddBatchProtocolId, 1803000000000-CreateEscapeIncidents,
1803500000000-CreateSensorTemperatureDaily, 1800400000000/1800600000000-FarmStockReadModel,
1806300000000-MigrateFeedingProgramsToProtocolV2. Frontend: web/modules/farm-module/src
(hooks/{useGrowth,useWaterQuality,useBatchTraceability,useTanks,useFeeding,useBatches}.ts,
graphql/growth.operations.ts, pages/production/tabs/{BatchTraceabilityTab,BatchTanksTab}.tsx,
pages/feeding/components/{GrowthForecastChart,FCRAnalysis}.tsx) and web/apps/aquamobil/src
(pages/{lice,welfare,escape,harvest,tank,HomePage}, hooks/{useTanks,useIncidentMediaUpload}.ts,
pwa/operation-registry.ts). No files were modified.

## Executive summary

The partition's schema placement is clean — every one of the ~24 production-biology entities
correctly omits `schema:` (ADR-011), and the batch-count SSoT (`tank_batches.batchDetails` via
`TankBatchService.applyBatchDelta`) is genuinely single-writer. The defects are provenance gaps:
four durable surfaces have readers but no writer. `batch_locations` is read by the
batch-traceability report, the `Batch.locations` GraphQL field and the target-FCR lookup chain, yet
no code in farm-service ever inserts a row — the shipped BatchTraceabilityTab renders "No tank
residencies recorded." permanently. `batches_v2.sgr` has four backend readers plus a web chart, is
never written, and both the feed-consumption forecast and the growth-forecast chart silently
substitute a hardcoded 1.5 %/day. `escape_incidents.varslingReportId` is never set, so the rømming
assembler's `varslingReportId IS NULL` filter re-reports the same escape forever.
`farm_incident_media` rows (regulatory incident photos uploaded from aquamobil) have no read path at
all. Secondary: `tank_batches.isOverCapacity` is never recomputed on removals; `updateHarvestRecord`
silently drops six declared input fields; a dead duplicate `tank_batches` writer survives in
`BatchService` carrying the retired `batchDetails` discard.

## Findings (by severity)

### MEDIUM

### DB-FARMPROD-MEDIUM-001

**Title:** `batch_locations` has zero writers while three read paths (batch traceability report,
Batch.locations, target-FCR chain) depend on it

**Severity:** MEDIUM (raised as HIGH, downgraded by adversarial verification)
**Layer:** 2
**State:** OPEN
**Raised as:** `DB-FARMPROD-HIGH-001` by `db-audit-farm-production` in cycle
`2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- apps/farm-service/src/batch/entities/batch-location.entity.ts:80 — `@Entity('batch_locations')`;
  no create/save call for this entity exists anywhere in apps/farm-service (grepped `BatchLocation`,
  `batch_locations`, `initialLocations`, `isCurrentLocation` repo-wide)
- apps/farm-service/src/batch/query-handlers/get-batch-traceability.handler.ts:130 —
  rows ARE the residency intervals"

  ```text
  const locations = await manager.find(BatchLocation, {` ; file header line 5: "`batch_locations
  ```

- apps/farm-service/src/growth/services/fcr-calculation.service.ts:799 —
  ;
  line 807 returns null so `getTargetFCRFromFeedingProgram` never resolves a program FCR

  ```text
  const activeLocation = await this.batchLocationRepository.findOne({ ... isCurrentLocation: true })
  ```

- apps/farm-service/src/batch/handlers/create-batch.handler.ts:373 — the `initialLocations` loop
  writes `TankAllocation` \+ `TankBatch` only, never a `BatchLocation` row
- web/modules/farm-module/src/pages/production/tabs/BatchTraceabilityTab.tsx:160 —
  `No tank residencies recorded.` is the permanent render state

**Rule violated:**

Lane-D methodology table-level verdict `ORPHAN-TABLE`/`MISSING-TABLE`; CLAUDE.md Architectural
Approach — "Missing field → add the `@Column` \+ DTO field" (here: the missing writer, not a
defensive read)

**Proposed fix direction:**

Make the residency ledger a by-product of the existing single stock writer rather than a second
thing handlers must remember: have `TankBatchService.applyBatchDelta` (already the one place every
stock in/out passes through) close the previous `batch_locations` interval and open the new one in
the same transaction, so a residency row cannot be missed. Tier-3 backstop: an invariant spec
asserting every table read by a query-handler or DataLoader has at least one persistence call site,
so a reader-without-writer fails CI.

**Affected surface (ripple set):**

- `apps/farm-service/src/batch/services/tank-batch.service.ts`
- `apps/farm-service/src/batch/handlers/create-batch.handler.ts`
- `apps/farm-service/src/batch/handlers/allocate-to-tank.handler.ts`
- `apps/farm-service/src/batch/handlers/transfer-batch.handler.ts`
- `apps/farm-service/src/batch/query-handlers/get-batch-traceability.handler.ts`
- `apps/farm-service/src/growth/services/fcr-calculation.service.ts`

  ```text
  apps/farm-service/src/database/migrations/ (backfill from tank_operations ledger)
  ```

- `web/modules/farm-module/src/pages/production/tabs/BatchTraceabilityTab.tsx`

**Expected closer:**

farm-expert WRITER mode (primary owner of apps/farm-service/**), with database-reviewer on the
backfill migration

**Verifier note:**

Facts verified. Repo-wide grep (excluding migrations and .archive) finds no create/save/INSERT for
BatchLocation anywhere: only the entity (batch-location.entity.ts:80), the dataloader,
batch.resolver.ts:608 `locations` ResolveField, get-batch-traceability.handler.ts:130,
fcr-calculation.service.ts:799, and module registration. transfer-batch.handler.ts contains no
BatchLocation reference; create-batch.handler.ts:373 writes TankAllocation/TankBatch/Equipment only.
So the table is genuinely orphaned and the traceability residency section renders 'No tank
residencies recorded.' permanently. Severity inflated: the claimed third consumer is not actually
broken — getTargetFCRFromFeedingProgram is priority #3 in getTargetFCR
(fcr-calculation.service.ts:636-650), preceded by batch.fcr.target and protocol-v2 and followed by
species growthParameters.targetFCR, so a null there degrades cleanly. No data corruption, no crash,
no tenant-isolation or security impact; this is a dead feature surface (empty residency table \+
empty Batch.locations), which is MEDIUM, not HIGH.

### DB-FARMPROD-MEDIUM-002

**Title:** `batches_v2.sgr` is never written but is read by four backend consumers and a web chart;
both forecast paths silently substitute a hardcoded 1.5 %/day

**Severity:** MEDIUM (raised as HIGH, downgraded by adversarial verification)
**Layer:** 2
**State:** OPEN
**Raised as:** `DB-FARMPROD-HIGH-002` by `db-audit-farm-production` in cycle
`2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- apps/farm-service/src/batch/entities/batch.entity.ts:232 — `sgr?: number;` (`@Column`
  decimal(5,4)); no assignment to `batch.sgr` exists in apps/farm-service (grepped `batch.sgr`,
  `sgr =`, `sgr:`)
- apps/farm-service/src/feeding/services/feed-consumption-forecast.service.ts:133 —

  ```text
  const sgr = (tankBatch.primaryBatchId && batchSgrMap.get(tankBatch.primaryBatchId)) || 1.5;
  ```

- web/modules/farm-module/src/pages/feeding/components/GrowthForecastChart.tsx:62 —
  `const batchSGR = selectedBatch?.sgr ?? 1.5;` feeding `growthSimulation` and the projected harvest
  date
- web/modules/farm-module/src/pages/feeding/components/FCRAnalysis.tsx:69 — `sgr: batch.sgr ?? 0,` →
  the SGR bar chart renders zero for every batch
- apps/farm-service/src/growth/handlers/record-growth-sample.handler.ts:180 — the real SGR IS
  computed (`specificGrowthRate: sgr`) but is only stored inside
  `growth_measurements.growthComparison` jsonb, never propagated to the batch column

**Rule violated:**

Lane-D column class `DEAD`/`SUSPECT` with live readers; CLAUDE.md Code Quality — no defensive
fallbacks masking an upstream gap (`?? 1.5` hides an unwritten column)

**Proposed fix direction:**

Pick one physical owner for batch SGR and delete the other surface. Preferred Tier-1: drop the
`batches_v2.sgr` column and expose `Batch.sgr` as a resolved field over the latest verified
`growth_measurements.growthComparison.specificGrowthRate`, so the value cannot exist un-derived. If
a stored snapshot is wanted for query performance, make
`RecordGrowthSampleHandler`/`UpdateBatchWeightFromSampleHandler` the sole writer in the same
transaction as the measurement. Either way remove the `?? 1.5` / `?? 0` fallbacks so an absent SGR
surfaces as absent instead of as a plausible number.

**Affected surface (ripple set):**

- `apps/farm-service/src/batch/entities/batch.entity.ts`
- `apps/farm-service/src/growth/handlers/record-growth-sample.handler.ts`

  ```text
  apps/farm-service/src/growth/handlers/update-batch-weight-from-sample.handler.ts
  ```

- `apps/farm-service/src/feeding/services/feed-consumption-forecast.service.ts`
- `apps/farm-service/src/events/listeners/harvest-completed.listener.ts`
- `apps/farm-service/src/equipment/equipment.resolver.ts`
- `web/modules/farm-module/src/pages/feeding/components/GrowthForecastChart.tsx`
- `web/modules/farm-module/src/pages/feeding/components/FCRAnalysis.tsx`

**Expected closer:**

farm-expert WRITER mode; cross-check with db-audit-farm-operations for the feed-forecast side

**Verifier note:**

Facts verified. batches_v2.sgr is declared at batch.entity.ts:232 (decimal(5,4)) and never assigned
anywhere in apps/farm-service — every hit is a read (feed-consumption-forecast.service.ts:113/133,
growth-simulator.service.ts:406-413 `let sgr = 1.5 // Default`, equipment.resolver.ts:381,
harvest-completed.listener.ts:356 `batch.sgr || 0`, close-batch.handler.ts:186) and
record-growth-sample.handler.ts:180 stores the computed SGR only inside
growth_measurements.growthComparison. Web fallbacks confirmed at GrowthForecastChart.tsx:62 and
FCRAnalysis.tsx:69. Severity inflated: the claimer missed that Batch.calculateSGR()
(batch.entity.ts:477) computes SGR on the fly and get-batch-performance.handler.ts:103 uses it, so
the primary performance query is correct. Impact is degraded forecasts (hardcoded 1.5%/day) and a
zeroed SGR bar chart — misleading output, not corruption or failure. MEDIUM.

### DB-FARMPROD-MEDIUM-003

**Title:** `escape_incidents.varslingReportId` is never written, so the rømming-varsling assembler
re-selects the same already-reported escape indefinitely

**Severity:** MEDIUM (raised as HIGH, downgraded by adversarial verification)
**Layer:** 2
**State:** OPEN
**Raised as:** `DB-FARMPROD-HIGH-003` by `db-audit-farm-production` in cycle
`2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- apps/farm-service/src/fish-health/entities/escape-incident.entity.ts:118 —
  `varslingReportId?: string;` documented as "Set once the varsling report for this incident is
  submitted"
- apps/farm-service/src/regulatory/assembly/assemblers/escape.assembler.ts:187 —
  `AND ei."varslingReportId" IS NULL` (line 88 comment: "escape_incidents (latest open, unreported
  incident)")
- apps/farm-service/src/fish-health/services/escape-incident.service.ts:151 — `close()` sets only
  `recoveredCount`, `recoveryOngoing`, `status`; no `varslingReportId` assignment exists anywhere
  (repo-wide grep returns only the entity, the assembler filter, the migration DDL and generated
  types)
- apps/farm-service/src/database/migrations/1803000000000-CreateEscapeIncidents.ts:53 —
  `"varslingReportId" uuid,` column created with no backfill or later writer

**Rule violated:**

Lane-D column class `WRITE-NONE with live reader`; ADR-006/CQRS — the submit path must close the
loop it opened; CLAUDE.md "Cross-service inconsistency → fix the contract AND both sides"

**Proposed fix direction:**

Make the link structural rather than remembered: on regulatory-report submission the same
transaction that flips the report to SUBMITTED must stamp `varslingReportId` on the source incident,
and the assembler should read that link instead of re-deriving "unreported" from a nullable column.
Tier-1 alternative: replace the nullable back-pointer with a report→incident join row created by the
submit handler, so an incident cannot be simultaneously submitted and unlinked.

**Affected surface (ripple set):**

- `apps/farm-service/src/fish-health/entities/escape-incident.entity.ts`
- `apps/farm-service/src/fish-health/services/escape-incident.service.ts`
- `apps/farm-service/src/regulatory/assembly/assemblers/escape.assembler.ts`
- `apps/farm-service/src/regulatory/ (report submit handler)`
- `apps/farm-service/src/database/migrations/`

**Expected closer:**

farm-expert WRITER mode (regulatory \+ fish-health seam)

**Verifier note:**

Write-absence verified: submitEscapeReport (regulatory-varsling.service.ts:101-137) only builds and
enqueues EscapeReportedEvent, and close() (escape-incident.service.ts:143-160) sets
recoveredCount/recoveryOngoing/status only; no assignment to varslingReportId exists repo-wide.
However the claimed impact is overstated — the assembler query (escape.assembler.ts:186-188) filters
`ei.status = 'open' AND ei."varslingReportId" IS NULL` and orders `detectedAt DESC, createdAt DESC`,
so a reported incident drops out as soon as it is closed, and any newer incident outranks it. It is
not selected 'indefinitely', and the assembler only prefills an operator-driven draft (fail-closed
MANUAL_REQUIRED otherwise), it does not auto-file. Residual real defect: an older unreported
incident is masked while a newer already-filed open incident exists, and re-assembly re-prefills an
already-filed incident. Narrow correctness gap, MEDIUM.

### DB-FARMPROD-MEDIUM-004

**Title:** `farm_incident_media` is write-only: incident photos uploaded from aquamobil are
persisted but have no read path on any surface

**Severity:** MEDIUM (raised as HIGH, downgraded by adversarial verification)
**Layer:** 2
**State:** OPEN
**Raised as:** `DB-FARMPROD-HIGH-004` by `db-audit-farm-production` in cycle
`2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- apps/farm-service/src/fish-health/services/incident-media.service.ts:128 —
  is the
  only touch of the table

  ```text
  await repo.save(repo.create({ tenantId, incidentType, referenceId, storageKey, ... }))
  ```

- apps/farm-service/src/fish-health/entities/escape-incident.entity.ts:51-135 — `EscapeIncident`
  declares no media relation/field; same for lice-count.entity.ts:28-114 and
  welfare-assessment.entity.ts
- apps/farm-service/schema.graphql:7191 — `requestIncidentMediaUpload(...)` is the only
  incident-media entry in the schema; no query, no presigned-GET, no `media` field on any incident
  type
- web/apps/aquamobil/src/components/PhotoCaptureField.tsx:64 —
  `const { uploadPhoto, isUploading } = useIncidentMediaUpload();` operators capture photos on the
  escape/lice/welfare pages
- apps/farm-service/src/regulatory/assembly/assemblers/escape.assembler.ts:181 — the varsling
  assembler selects from `escape_incidents` only; media is not part of any report payload

**Rule violated:**

Lane-D column class `WRITE-ONLY`; CLAUDE.md Architectural Approach — a feature is not shipped until
the read side exists

**Proposed fix direction:**

Complete the contract in one direction or remove the capture affordance. Preferred: expose media as
a resolved field on each incident ObjectType backed by a polymorphic DataLoader over
`(incidentType, referenceId)`, minting tenant-verified presigned GET URLs through the same MinIO
service that mints the PUT, and surface it on the report-review and incident-detail screens. Also
fix the correction path: `LiceCountService.record` re-invokes `attach()` on upsert
(lice-count.service.ts:81) so corrected counts accumulate duplicate media rows.

**Affected surface (ripple set):**

- `apps/farm-service/src/fish-health/entities/farm-incident-media.entity.ts`
- `apps/farm-service/src/fish-health/services/incident-media.service.ts`
- `apps/farm-service/src/fish-health/services/lice-count.service.ts`
- `apps/farm-service/src/fish-health/resolvers/field-capture.resolver.ts`
- `apps/farm-service/schema.graphql`
- `web/apps/aquamobil/src/pages/reports/ReportReviewPage.tsx`
- `web/modules/farm-module/src/pages/reports/`

**Expected closer:**

farm-expert WRITER mode \+ frontend-expert for the render surface

**Verifier note:**

Verified write-only. FarmIncidentMedia appears only in farm-incident-media.entity.ts,
fish-health.module.ts:85, and incident-media.service.ts (presign at :68, single repo.save at :128);
no findOne/find/query against it and no raw SELECT on farm_incident_media anywhere in apps/, web/ or
libs/. schema.graphql exposes only requestIncidentMediaUpload (:7191) and
IncidentMediaUploadResponse (:4849) — no query, no presigned GET, no media field on
EscapeIncident/LiceCount/WelfareAssessment. escape.assembler.ts selects escape_incidents only, so
media is not in the varsling payload. Severity inflated: nothing is lost or corrupted — the MinIO
objects and the DB rows persist with tenant-prefixed keys, MIME and size validated, and a read path
can be added later against existing data. This is an unshipped read side for an operator-facing
capture feature, MEDIUM, not HIGH.

### DB-FARMPROD-MEDIUM-005

**Title:** A second, production-dead `tank_batches` writer survives in `BatchService` and still
contains the retired `batchDetails` discard that the count-SSoT service was created to remove

**Severity:** MEDIUM
**Layer:** 2
**State:** OPEN
**Raised as:** `DB-FARMPROD-MEDIUM-005` by `db-audit-farm-production` in cycle
`2026-08-16-farm-mobile-agent-audit`
**Verification:** not adversarially verified (only CRITICAL/HIGH claims entered the verify stage)

**Evidence:**

- apps/farm-service/src/batch/services/batch.service.ts:567 —
  `tankBatch.batchDetails = batchDetails.length > 1 ? batchDetails : undefined;` (identical at :644
  in `updateTankBatchWithManager`)
- apps/farm-service/src/batch/services/tank-batch.service.ts:16 — the SSoT writer's docblock states
  " discard
  is the drift this fixes)"

  ```text
  batchDetails[]` is ALWAYS persisted (the historical `length > 1 ? details : undefined
  ```

- apps/farm-service/src/batch/services/batch.service.ts:301,466,467,743 — live call sites of the
  duplicate writer inside `allocateBatchToTank` / `transferBatch` / `recordOperation`
- apps/farm-service/src/batch/controllers/batch.controller.ts:420,437 — the only controller uses of
  , so the
  duplicate writer is unreachable in production

  ```text
  BatchService` are the two read methods; every mutation routes through `CommandBus
  ```

- —
  `batchService.allocateBatchToTank({` : the postgres tenant-isolation e2e suite exercises the dead
  path, not the live handler path

  ```text
  apps/farm-service/src/**tests**/e2e/batch-allocation-tenant-isolation.postgres.spec.ts:339
  ```

**Rule violated:**

Lane-D table verdict `DUPLICATE-STRUCTURE`; agent domain invariant "batch/tank count mutations flow
through the shared tank-batch delta service"; layer-2-defect-catalog Duplication/DRY

**Proposed fix direction:**

Delete the mutating half of `BatchService` (`createBatch`, `allocateBatchToTank`, `transferBatch`,
`recordOperation`, `updateTankBatch`, `updateTankBatchWithManager`) and repoint the three postgres
e2e specs at the CQRS handlers they are meant to certify, so tenant-isolation assurance covers the
code production actually runs. Tier-3 backstop: extend the existing `farm-tank-count-ssot` invariant
to assert `tank_batches` is written from exactly one module file.

**Affected surface (ripple set):**

- `apps/farm-service/src/batch/services/batch.service.ts`
- `apps/farm-service/src/batch/batch.module.ts`
- `apps/farm-service/src/batch/controllers/batch.controller.ts`
- `apps/farm-service/src/batch/**tests**/services/batch.service.spec.ts`

  ```text
  apps/farm-service/src/**tests**/e2e/batch-allocation-tenant-isolation.postgres.spec.ts
  ```

  ```text
  apps/farm-service/src/**tests**/e2e/mortality-cull-harvest-tenant-isolation.postgres.spec.ts
  ```

  ```text
  apps/farm-service/src/**tests**/e2e/feeding-record-tenant-isolation.postgres.spec.ts
  ```

- `tests/invariants/farm-batch-policy-transaction-ssot.spec.ts`

**Expected closer:**

farm-expert WRITER mode, with test-runner re-pointing the e2e suites

### DB-FARMPROD-MEDIUM-006

**Title:** `tank_batches.isOverCapacity` / `capacityUsedPercent` are never recomputed on stock
removals, so an over-capacity alarm persists after mortality, cull or harvest empties the tank

**Severity:** MEDIUM
**Layer:** 2
**State:** OPEN
**Raised as:** `DB-FARMPROD-MEDIUM-006` by `db-audit-farm-production` in cycle
`2026-08-16-farm-mobile-agent-audit`
**Verification:** not adversarially verified (only CRITICAL/HIGH claims entered the verify stage)

**Evidence:**

- apps/farm-service/src/batch/services/tank-batch.service.ts:162-190 — the single delta writer
  re-derives but
  never touches `isOverCapacity` or `capacityUsedPercent`

  ```text
  totalQuantity`, `totalBiomassKg`, `avgWeightG`, `densityKgM3`, `currentBiomassKg
  ```

- apps/farm-service/src/batch/handlers/record-mortality.handler.ts:306 —
  `await this.tankBatchService.applyBatchDelta(...)` is the only tank_batches write on the mortality
  path; no capacity recompute follows (same shape in record-cull.handler.ts:252)
- apps/farm-service/src/batch/handlers/allocate-to-tank.handler.ts:259 —
  `savedTankBatch.isOverCapacity = capacity.isOverCapacity;` shows the flags are refreshed only on
  inflow paths (also create-batch.handler.ts:433-434, transfer-batch.handler.ts:372/400)
- web/apps/aquamobil/src/pages/HomePage.tsx:125 —
  drives the mobile dashboard warning count

  ```text
  const overCapacityCount = activeTanks.filter((t) => t.batchMetrics?.isOverCapacity).length;
  ```

- apps/farm-service/src/farm-stock/farm-stock-projection.service.ts:55 — the read-model projection
  copies `tb."capacityUsedPercent"` / `tb."isOverCapacity"` verbatim, propagating the stale value

**Rule violated:**

Lane-D `SUSPECT`/derived-column staleness; agent domain invariant "Over-capacity is not a defect" —
but a flag that cannot clear is not the legitimate override flow; layer-2 Correctness (non-atomic
read-compute-write of derived state)

**Proposed fix direction:**

Derive the two capacity fields inside `TankBatchService.applyBatchDelta` from the just-computed
`totalBiomassKg`/`densityKgM3` plus the tank's `maxBiomass`/`maxDensity`, so every stock change —
inflow or outflow — refreshes them from one formula and the inflow handlers stop setting them
independently. That removes the asymmetry structurally rather than adding a recompute call to each
removal handler. The admin-override audit-log path (tank-capacity.service.ts:249) stays untouched
and keeps its trail.

**Affected surface (ripple set):**

- `apps/farm-service/src/batch/services/tank-batch.service.ts`
- `apps/farm-service/src/tank/services/tank-capacity.service.ts`
- `apps/farm-service/src/batch/handlers/allocate-to-tank.handler.ts`
- `apps/farm-service/src/batch/handlers/create-batch.handler.ts`
- `apps/farm-service/src/batch/handlers/transfer-batch.handler.ts`
- `apps/farm-service/src/farm-stock/farm-stock-projection.service.ts`
- `web/apps/aquamobil/src/pages/tank/TankDetailPage.tsx`

**Expected closer:**

farm-expert WRITER mode

### DB-FARMPROD-MEDIUM-007

**Title:** `updateHarvestRecord` accepts six declared input fields (including the `qualityApproved`
regulatory gate) and silently discards them; the drop is enabled by a banned `as unknown as` cast

**Severity:** MEDIUM
**Layer:** 1
**State:** OPEN
**Raised as:** `DB-FARMPROD-MEDIUM-007` by `db-audit-farm-production` in cycle
`2026-08-16-farm-mobile-agent-audit`
**Verification:** not adversarially verified (only CRITICAL/HIGH claims entered the verify stage)

**Evidence:**

- apps/farm-service/src/harvest/dto/update-harvest-record.input.ts:132-145 — `qualityApproved`,
  :106,
  `lotNumber`:112, `pricePerKg`:82)

  ```text
  qualityApprovedBy`, `qualityApprovedAt` are declared `@Field`s (also `buyerName
  ```

- apps/farm-service/src/harvest/handlers/update-harvest-record.handler.ts:34-48 — `UPDATABLE_FIELDS`
  omits all six; only `qualityClass` gets an extra explicit branch at :94
- apps/farm-service/src/harvest/resolvers/harvest.resolver.ts:390-402 — the resolver builds the
  command payload field-by-field and never threads those six
- apps/farm-service/src/harvest/handlers/update-harvest-record.handler.ts:88 —
  `(harvestRecord as unknown as Record<string, unknown>)[field] = incoming;` — FORBIDDEN cast per
  CLAUDE.md, and precisely what lets the DTO and the persisted set diverge without a compile error
- apps/farm-service/src/harvest/handlers/list-harvests.handler.ts:118 —
  `if (filter.qualityApproved !== undefined)` filters on a column no code path ever sets to true

**Rule violated:**

CLAUDE.md Code Quality — `as unknown as X` is FORBIDDEN; Lane-D class `UI-WITHOUT-DB` (input field
with no durable counterpart); layer-2-defect-catalog Architecture/contract drift

**Proposed fix direction:**

Replace the string-keyed copy loop with an explicit typed mapping from `UpdateHarvestRecordData`
onto the entity so the compiler rejects any DTO field that has no persistence target — that makes
the class of bug impossible rather than detectable. Then decide per field: thread
`pricePerKg`/`buyerName`/`lotNumber` through the command, and model quality approval as its own
guarded transition (`approveHarvestQuality`) that writes `qualityApproved`/`approvedBy`/`approvedAt`
together, since the entity's `approveQuality()` method already encodes the invariant and has no
caller.

**Affected surface (ripple set):**

- `apps/farm-service/src/harvest/dto/update-harvest-record.input.ts`
- `apps/farm-service/src/harvest/commands/update-harvest-record.command.ts`
- `apps/farm-service/src/harvest/handlers/update-harvest-record.handler.ts`
- `apps/farm-service/src/harvest/resolvers/harvest.resolver.ts`
- `apps/farm-service/src/harvest/entities/harvest-record.entity.ts`
- `apps/farm-service/schema.graphql`

**Expected closer:**

farm-expert WRITER mode

### DB-FARMPROD-MEDIUM-008

**Title:** `batches_v2.protocolId` was added by migration for the batch→feeding-protocol link but
has no writer, leaving the feed-selection fallback and the v1→v2 protocol cutover derivation
permanently empty

**Severity:** MEDIUM
**Layer:** 2
**State:** OPEN
**Raised as:** `DB-FARMPROD-MEDIUM-008` by `db-audit-farm-production` in cycle
`2026-08-16-farm-mobile-agent-audit`
**Verification:** not adversarially verified (only CRITICAL/HIGH claims entered the verify stage)

**Evidence:**

- apps/farm-service/src/database/migrations/1802000000000-AddBatchProtocolId.ts:6 — "Adds
  `batches_v2.protocolId` — the feeding protocol a batch is created with"; DDL at :33, index at :37
- apps/farm-service/src/batch/entities/batch.entity.ts:123 — `protocolId?: string;` exposed as a
  GraphQL `ID`; no assignment exists in any batch DTO, command, resolver or handler (grepped
  `protocolId` across apps/farm-service/src/batch)
- apps/farm-service/src/equipment/dataloaders/feed-selection.dataloader.ts:196-198 —
  (comment at
  :194: "a protocol takes precedence over batch_feed_assignments (it IS the feed driver)") always
  returns zero rows

  ```text
  SELECT "id", "protocolId" FROM ... batches_v2 WHERE ... "protocolId" IS NOT NULL
  ```

- apps/farm-service/src/database/migrations/1806300000000-MigrateFeedingProgramsToProtocolV2.ts:103-109
  — the cutover derives v2 assignments from `b."protocolId" IS NOT NULL`, i.e. from an always-null
  column
- apps/farm-service/src/batch/query-handlers/get-batch-traceability.handler.ts:99 — comment records
  the v1 read path as retired, but the column and its two consumers were left in place

**Rule violated:**

Lane-D column class `DEAD` (migration-created, never written) with live readers; agent domain
invariant "protocol-driven feeding boundary" — batch side audited here, feed side cross-referenced
to db-audit-farm-operations

**Proposed fix direction:**

Resolve the seam in one direction: if unit-level `feeding_protocol_assignments` is the declared
owner of protocol provenance (as the traceability handler already assumes), drop
`batches_v2.protocolId` and the dead protocol branch in the feed-selection DataLoader in the same
change, with a `BREAKING CHANGE:` footer for the removed GraphQL field. If a batch-level protocol is
still wanted, add it to the create/update-batch DTO \+ command so the column has an owner. Do not
leave a column whose only consumers are guaranteed-empty queries.

**Affected surface (ripple set):**

- `apps/farm-service/src/batch/entities/batch.entity.ts`
- `apps/farm-service/src/equipment/dataloaders/feed-selection.dataloader.ts`
- `apps/farm-service/src/database/migrations/`
- `apps/farm-service/schema.graphql`
- `web/modules/farm-module/src/hooks/useBatchTraceability.ts`

**Expected closer:**

farm-expert WRITER mode; requires arbitration with db-audit-farm-operations on the protocol→rate
ownership seam

### DB-FARMPROD-MEDIUM-009

**Title:** `recordTreatmentApplication` and `closeEscapeIncident` mutations have no caller on any
frontend, leaving the lakselus report's `behandlinger` section unfillable and escape incidents
unclosable

**Severity:** MEDIUM
**Layer:** 2
**State:** OPEN
**Raised as:** `DB-FARMPROD-MEDIUM-009` by `db-audit-farm-production` in cycle
`2026-08-16-farm-mobile-agent-audit`
**Verification:** not adversarially verified (only CRITICAL/HIGH claims entered the verify stage)

**Evidence:**

- apps/farm-service/src/fish-health/resolvers/field-capture.resolver.ts:137 —

  ```text
  async recordTreatmentApplication(...)` and :185 — `async closeEscapeIncident(...)
  ```

- apps/farm-service/src/regulatory/assembly/assemblers/lakselus.assembler.ts:121 —
  feeding the
  report's `behandlinger` (header line 15)

  ```text
  treatments: await this.queryTreatments(qr, tenantId, siteId, fromDate, toDate),
  ```

- web/shared-ui/src/generated/graphql-types.ts:9717,9434 — `recordTreatmentApplication` /
  `closeEscapeIncident` exist only in generated types; no page, hook or operation document in
  web/modules/farm-module or web/apps/aquamobil references either (aquamobil ships recordLiceCount,
  recordWelfareAssessment, recordEscapeIncident only —
  web/apps/aquamobil/src/pwa/operation-registry.ts:199-218)
- apps/farm-service/src/fish-health/resolvers/field-capture.resolver.ts:59-113 — the `liceCounts` /
  `welfareAssessments` / `treatmentApplications` / `escapeIncidents` list queries likewise have no
  frontend consumer, so recorded field data is never listable or correctable from a UI

**Rule violated:**

Lane-D class `BE-ONLY` without a legitimate derived purpose on the write side (a regulatory record
with no capture surface); layer-2 Architecture/contract drift

**Proposed fix direction:**

Treat the regulatory field-capture set as one product surface rather than four independent
mutations: add the treatment-application capture screen to aquamobil alongside the existing
lice/welfare/escape pages (same offline-queue operation-registry pattern), and give the escape
incident a close action on the report-review screen. Add the four list queries to a farm-module
fish-health tab so recorded records are inspectable and correctable. Tier-3 backstop: extend the
existing permission-matrix/mutation-classification invariant with a reachability assertion so a
mutation shipped with no client operation fails CI.

**Affected surface (ripple set):**

- `web/apps/aquamobil/src/pages/ (new treatment capture page)`
- `web/apps/aquamobil/src/pwa/operation-registry.ts`
- `web/apps/aquamobil/src/utils/offline-sync-invalidation.ts`
- `web/apps/aquamobil/src/pages/reports/ReportReviewPage.tsx`
- `web/modules/farm-module/src/pages/health/`
- `apps/farm-service/src/fish-health/resolvers/field-capture.resolver.ts`

**Expected closer:**

farm-expert TEACHER → frontend-expert WRITER mode for the aquamobil \+ farm-module surfaces

### LOW

### DB-FARMPROD-LOW-010

**Title:** Ten `harvest_records` columns and three entity business methods have no writer at all

**Severity:** LOW
**Layer:** 1
**State:** OPEN
**Raised as:** `DB-FARMPROD-LOW-010` by `db-audit-farm-production` in cycle
`2026-08-16-farm-mobile-agent-audit`
**Verification:** not adversarially verified (only CRITICAL/HIGH claims entered the verify stage)

**Evidence:**

- apps/farm-service/src/harvest/entities/harvest-record.entity.ts:427,474,494,502,580 —
  jsonb/array
  columns; also `minWeight`:415, `maxWeight`:419, `qualityApproved`:478, `approvedBy`:568,
  `approvedAt`:572

  ```text
  sizeDistribution`, `qualityControl`, `yieldCalculation`, `shipment`, `attachments
  ```

- apps/farm-service/src/harvest/handlers/create-harvest-record.handler.ts:305-344 — the only insert
  sets `operation`, `lotInfo`, `customerDeliveries` and the scalar quantities; none of the ten
  columns above
- apps/farm-service/src/harvest/entities/harvest-record.entity.ts:605 `approveQuality(...)`, :615
  `prepareForShipment(...)`, :646 `calculateYield(...)` — repo-wide grep finds no caller for any of
  the three
- apps/farm-service/src/harvest/handlers/list-harvests.handler.ts:118 — a filter is offered on
  `qualityApproved`, a column permanently `false`

**Rule violated:**

Lane-D column class `DEAD`; layer-2-defect-catalog Hygiene (unreachable code paths)

**Proposed fix direction:**

Decide per column: either wire the entity methods into commands (quality approval, shipment, yield)
so the columns have owners, or drop the columns and methods with a `BREAKING CHANGE:` footer and
remove the `qualityApproved` list filter. Leaving nullable jsonb columns that no path writes invites
future readers to trust them.

**Affected surface (ripple set):**

- `apps/farm-service/src/harvest/entities/harvest-record.entity.ts`
- `apps/farm-service/src/harvest/handlers/create-harvest-record.handler.ts`
- `apps/farm-service/src/harvest/handlers/list-harvests.handler.ts`
- `apps/farm-service/src/database/migrations/`
- `apps/farm-service/schema.graphql`

**Expected closer:**

farm-expert WRITER mode

### DB-FARMPROD-LOW-011

**Title:** `water_quality_measurements.alertRuleId`, `.alertIncidentId` and `.sensorInfo` are
declared and GraphQL-exposed but never written

**Severity:** LOW
**Layer:** 1
**State:** OPEN
**Raised as:** `DB-FARMPROD-LOW-011` by `db-audit-farm-production` in cycle
`2026-08-16-farm-mobile-agent-audit`
**Verification:** not adversarially verified (only CRITICAL/HIGH claims entered the verify stage)

**Evidence:**

- apps/farm-service/src/water-quality/entities/water-quality-measurement.entity.ts:305
  — all
  three carry `@Field`

  ```text
  alertRuleId?: string;`, :309 `alertIncidentId?: string;`, :317 `sensorInfo?: SensorInfo;
  ```

- apps/farm-service/src/water-quality/water-quality.service.ts:301-303 — the create path persists
  `relatedSensorReadingId` and `hasAlarm` only; no assignment to the three columns exists anywhere
  in apps/farm-service
- apps/farm-service/src/water-quality/water-quality.service.ts:340 —
  `if (saved.hasAlarm && saved.summary?.evaluations)` is the alarm fan-out, and it never writes back
  the resulting rule/incident id

**Rule violated:**

Lane-D column class `DEAD`; layer-2-defect-catalog Hygiene

**Proposed fix direction:**

Either close the alert correlation loop — have the alert fan-out stamp the originating rule/incident
id back onto the measurement in the same transaction, matching the `relatedSensorReadingId`
correlation pattern already documented on the entity — or drop the three columns and their GraphQL
fields. `sensorInfo` is superseded by `relatedSensorReadingId` and should go.

**Affected surface (ripple set):**

```text
apps/farm-service/src/water-quality/entities/water-quality-measurement.entity.ts
```

- `apps/farm-service/src/water-quality/water-quality.service.ts`
- `apps/farm-service/src/database/migrations/`
- `apps/farm-service/schema.graphql`

**Expected closer:**

farm-expert WRITER mode; alert-engine-expert consulted on the correlation contract

### DB-FARMPROD-LOW-012

**Title:** `BatchTanksTab` promises a per-tank allocation list with no durable read path, and defers
the gap in a comment with no owner, deadline or finding ID

**Severity:** LOW
**Layer:** 3
**State:** OPEN
**Raised as:** `DB-FARMPROD-LOW-012` by `db-audit-farm-production` in cycle
`2026-08-16-farm-mobile-agent-audit`
**Verification:** not adversarially verified (only CRITICAL/HIGH claims entered the verify stage)

**Evidence:**

- web/modules/farm-module/src/pages/production/tabs/BatchTanksTab.tsx:4 — "Renders the batch's
  current tank allocations" while :7-11 admits "the list itself reads from `batch.currentQuantity`
  ... would need a `batch.tankAllocations` field on the Batch GraphQL type ... the detailed
  allocation list lands as part of PR-2/PR-3"
- web/modules/farm-module/src/pages/production/tabs/BatchTanksTab.tsx:31 —
  — a batch-global count presented as per-tank availability

  ```text
  function estimateAvailableForAllocation(batch: Batch) { return Math.max(0, batch.currentQuantity); }
  ```

- apps/farm-service/src/batch/controllers/batch.controller.ts:420 — `tank_allocations` is readable
  only over REST `GET /api/batches/:id/allocations`, which no web or mobile client calls
- apps/farm-service/src/batch/resolvers/batch.resolver.ts:608 — the one GraphQL relation that would
  serve this tab is `locations`, which is empty per DB-FARMPROD-HIGH-001

**Rule violated:**

CLAUDE.md Architectural Approach — "deferred"/"lands as part of PR-2/PR-3" is FORBIDDEN without an
explicit owner \+ deadline \+ tracked finding ID; Lane-D class `UI-WITHOUT-DB`

**Proposed fix direction:**

Expose the batch's per-tank composition from the existing SSoT (`tank_batches.batchDetails`) as a
resolved field on `Batch` and have the tab render it, which removes the estimate function entirely.
Until that lands the tab should not display a batch-global number as per-tank availability. Convert
the deferral comment into a tracked finding with owner and deadline, or delete it.

**Affected surface (ripple set):**

- `web/modules/farm-module/src/pages/production/tabs/BatchTanksTab.tsx`
- `apps/farm-service/src/batch/resolvers/batch.resolver.ts`
- `apps/farm-service/src/batch/dataloaders/`
- `apps/farm-service/schema.graphql`
- `web/modules/farm-module/src/hooks/useBatches.ts`

**Expected closer:**

farm-expert WRITER mode (backend field) \+ frontend-expert (tab render)

## Inventory — what exists / what is missing

| Status          | Area                                                             | Note                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MISSING**     | batch_locations (BatchLocation) — residency history              | Table, entity, indexes, DataLoader, traceability aggregation and a shipped web tab all exist; nothing writes a row. The batch traceability report renders zero residencies and the target-FCR-from-feeding-program chain always short-circuits. See DB-FARMPROD-HIGH-001.                                                                                                                                                                            |
| **PARTIAL**     | Type-system discipline in the partition                          | The partition is almost free of banned casts; the one violation found is the string-keyed field-copy loop in the harvest update handler, which is also the mechanism enabling the silent field drop reported as MEDIUM-007.                                                                                                                                                                                                                          |
| **PARTIAL**     | batches_v2 (Batch) — write→read→UI roundtrip                     | Core lifecycle columns (counts, weight/fcr/growthMetrics jsonb, status, dates, supplier, cost) have full CQRS writers, GraphQL reads and farm-module/aquamobil surfaces. Three columns are declared and exposed but never written: `sgr`, `protocolId`, and the derived-only display getters. `cullCount`, `retentionRate`, `harvestedQuantity`, `totalFeedConsumed`/`totalFeedCost` are correctly written.                                          |
| **PARTIAL**     | escape_incidents (EscapeIncident)                                | Recording is robust (mobile-command receipt dedup, outbox event, tenant transaction). Two gaps: `varslingReportId` is never written so the assembler re-selects reported incidents forever (HIGH-003), and `closeEscapeIncident` has no UI caller so incidents cannot be closed.                                                                                                                                                                     |
| **PARTIAL**     | farm_incident_media (FarmIncidentMedia)                          | Write-only. Presigned upload, MIME/size/tenant-prefix re-validation on finalize, and rows written in the incident's transaction — but no query, no `media` field on any incident type, no presigned GET. Uploaded regulatory photo evidence is unreachable after capture. See DB-FARMPROD-HIGH-004.                                                                                                                                                  |
| **PARTIAL**     | harvest_records (HarvestRecord)                                  | Create/list/get/statistics/delete are complete with lot-number sequencing under lock, TankOperation ledger entry, batch decrement and outbox events; aquamobil RecordHarvestPage writes. Ten columns have no writer (LOW-010) and `updateHarvestRecord` silently drops six declared inputs (MEDIUM-007).                                                                                                                                             |
| **PARTIAL**     | lice_counts (LiceCount)                                          | Write path is complete and correct (aquamobil LiceCountPage → offline queue → upsert keyed on tenant/tank/date, ISO week derived at write time, tenant-scoped repo). Read path is BE-ONLY: the lakselus assembler consumes it, but the `liceCounts` GraphQL query has no frontend consumer, so recorded counts cannot be listed or reviewed in any UI.                                                                                               |
| **PARTIAL**     | tank_allocations (TankAllocation) — allocation ledger            | Written by create-batch, allocate-to-tank and transfer-batch handlers as an audit ledger. Read exposure is REST-only (`GET /api/batches/:id/allocations`); no GraphQL field and no web or mobile consumer calls that endpoint, so the ledger is effectively BE-ONLY.                                                                                                                                                                                 |
| **PARTIAL**     | treatment_applications (TreatmentApplication)                    | Backend is complete — write-time validation against official Mattilsynet method/virkestoff values, list query, and consumption by the lakselus assembler's `behandlinger` section. No frontend anywhere calls `recordTreatmentApplication`, so the table can only ever be empty in practice.                                                                                                                                                         |
| **PARTIAL**     | welfare_assessments (WelfareAssessment)                          | Same shape as lice_counts: aquamobil WelfareScorePage writes, the welfare assembler reads, the `welfareAssessments` query has no frontend consumer.                                                                                                                                                                                                                                                                                                  |
| **IMPLEMENTED** | ADR-011 schema placement across the partition                    | All ~24 production-biology entities (batch, tank, growth, fish-health, water-quality, harvest, species) correctly OMIT `schema:` so search_path routes them into `tenant_<uuid>`. No WRONG-SCHEMA-PLACEMENT and no `public` table found in this partition; the only `schema:'farm'` declarations in farm-service are the outbox, farm_audit_logs and tenant_erasure_audit, which are the legitimate cross-tenant set.                                |
| **IMPLEMENTED** | Tenant isolation across the partition's write paths              | Every write path traced in this partition uses `runInTenantTransaction` / `runInTenantRead` / `tenantManagerRepo`; no bare `getRepository()` was found in batch, tank, growth, fish-health, water-quality, harvest or species. No cross-tenant leak observed in this pass.                                                                                                                                                                           |
| **IMPLEMENTED** | batch_documents \+ batch_feed_assignments                        | Both written on the create-batch / assign-feeds paths and read through request-scoped tenant DataLoaders exposed as `Batch.documents` and `Batch.feedAssignments`, rendered by farm-module production components.                                                                                                                                                                                                                                    |
| **IMPLEMENTED** | growth_measurements (GrowthMeasurement)                          | Complete: recordGrowthSample / verifyMeasurement / updateBatchWeightFromSample mutations, statistics \+ growthComparison \+ fcrAnalysis jsonb computed at write time, five GraphQL queries, and a farm-module GrowthTab with hooks and operation documents. The only gap is that the computed SGR never reaches `batches_v2.sgr` (HIGH-002).                                                                                                         |
| **IMPLEMENTED** | harvest_plans (HarvestPlan)                                      | Service-backed CRUD including `attachments`, seven read handlers (by code, by batch, upcoming, overdue, stats), a resolver, and a farm-module HarvestPlansPage.                                                                                                                                                                                                                                                                                      |
| **IMPLEMENTED** | health_events (HealthEvent)                                      | Create/update mutations, filter/stats/critical/overdue-follow-up query handlers, and a farm-module HealthEventsPage. `alertIncidentId` is settable through the DTO here, unlike its water-quality namesake.                                                                                                                                                                                                                                          |
| **IMPLEMENTED** | mortality_records (MortalityRecord)                              | Full roundtrip: written on the record-mortality path with cause/severity/water-quality snapshot, read via GraphQL and the mortality-by-cause query, surfaced in farm-module production and aquamobil RecordMortalityPage.                                                                                                                                                                                                                            |
| **IMPLEMENTED** | sensor_temperature_latest \+ sensor_temperature_daily            | Legitimately BE-ONLY per the aggregation-fed-column rule: the projection job exists and is verified. `SensorTemperatureProjectionListener` folds sensor-service SensorReading events into both tables with newest-wins / watermark idempotency; consumed by the feeding-rate calc and the settefisk regulatory period temperature.                                                                                                                   |
| **IMPLEMENTED** | species (Species)                                                | Setup-table roundtrip with a federation key, official regulatory `officialCode` mapping seeded from an in-repo SSoT, cleaner-fish flags, and jsonb growth/optimal/market/breeding blocks consumed by batch creation and the growth analysis target SGR.                                                                                                                                                                                              |
| **IMPLEMENTED** | tank_batches (TankBatch) — batch-count SSoT                      | `batchDetails[]` is a genuine single-owner SSoT: `TankBatchService.applyBatchDelta` derives totalQuantity/biomass/avgWeight/density from it, is the only writer of the denormalized `Tank`/`Equipment.currentCount`, and rejects per-tank overdraft instead of clamping. The retired `currentQuantity` count mirror is gone. Gap: the capacity flags are not refreshed on removals (MEDIUM-006), and a dead second writer still exists (MEDIUM-005). |
| **IMPLEMENTED** | tank_operations (TankOperation) — stock-movement ledger          | Written by mortality, cull, transfer and harvest handlers with pre-operation state snapshots; read by the batch-history assembler and the FCR net-exited-biomass calculation, and surfaced through the batch history UI.                                                                                                                                                                                                                             |
| **IMPLEMENTED** | tanks (Tank) \+ tank capacity                                    | Full CRUD via CQRS, volume auto-derived in lifecycle hooks, `currentCount` written by the single TankBatchService writer, `currentBiomass` on its own growth-tracking path. The admin-override over-capacity flow retains its audit-log entry, so it is the legitimate shape, not a defect.                                                                                                                                                          |
| **IMPLEMENTED** | water_quality_measurements (WaterQualityMeasurement)             | Full roundtrip: aquamobil WaterQualityRecordPage \+ farm-module water-chemistry RecordTab write; seven query handlers (get/list/latest/critical/chart/stats, by tank and by system) read; farm-module useWaterQuality hooks render. Idempotency key and sensor-reading correlation are wired. Three columns are dead (LOW-011).                                                                                                                      |
| **IMPLEMENTED** | water_quality_parameter_configs \+ water_quality_param_equipment | Complete CQRS surface (create/update/delete/reorder/bulk-from-template/bulk-map), tenant-onboarding seeder, and dedicated farm-module UI (ParameterConfigManager, EquipmentMappingPanel) with hooks.                                                                                                                                                                                                                                                 |

## Verdict

BLOCK

## References

- Cycle report: `docs/reviews/orchestrator/2026-08-16-farm-mobile-audit-cycle.md`
- Finding format: `.claude/shared/output-format.md`
- Agent definition: `.claude/agents/**/db-audit-farm-production.md`
- Rule SSoT: `CLAUDE.md`
