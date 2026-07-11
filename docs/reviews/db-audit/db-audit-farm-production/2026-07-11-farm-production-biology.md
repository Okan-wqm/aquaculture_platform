# DB Audit — Farm Production Biology Partition — 2026-07-11

**Agent:** db-audit-farm-production (Lane-D, CATCHER)
**Cycle:** 2026-07-11
**Partition:** `apps/farm-service` domains `batch/`, `tank/`, `growth/`, `fish-health/`, `water-quality/`, `harvest/`, `species/` (schema-per-tenant `farm`); FE surfaces `web/modules/farm-module`, `web/apps/aquamobil`; farm event contracts.

> Status: COMPLETE — all 7 in-scope domains traced (23 `@Entity` classes).

## Scope

Every `@Entity` class in the in-scope domains was enumerated per class. 23 entities:

| Domain | Entity | Table | `schema:` | write/read/fe verdict |
|---|---|---|---|---|
| batch | Batch | `batches_v2` | omit (OK) | OK |
| batch | TankBatch | `tank_batches` | omit (OK) | OK + DUPLICATE cols |
| batch | TankAllocation | `tank_allocations` | omit (OK) | OK |
| batch | TankOperation | `tank_operations` | omit (OK) | OK (ledger) |
| batch | MortalityRecord | `mortality_records` | omit (OK) | OK + dual-count |
| batch | BatchLocation | `batch_locations` | omit (OK) | OK |
| batch | BatchDocument | `batch_documents` | omit (OK) | OK |
| batch | BatchFeedAssignment | `batch_feed_assignments` | omit (OK) | OK (audit cols write-only) |
| tank | Tank | `tanks` | omit (OK) | OK + DUPLICATE col |
| growth | GrowthMeasurement | `growth_measurements` | omit (OK) | OK |
| fish-health | HealthEvent | `health_events` | omit (OK) | OK |
| fish-health | LiceCount | `lice_counts` | omit (OK) | **FE-UNREACHABLE writer** |
| fish-health | TreatmentApplication | `treatment_applications` | omit (OK) | **FE-UNREACHABLE writer** |
| fish-health | WelfareAssessment | `welfare_assessments` | omit (OK) | **FE-UNREACHABLE writer** |
| fish-health | EscapeIncident | `escape_incidents` | omit (OK) | **FE-UNREACHABLE writer** |
| water-quality | WaterQualityMeasurement | `water_quality_measurements` | omit (OK) | OK |
| water-quality | WaterQualityParameterConfig | `water_quality_parameter_configs` | omit (OK) | OK |
| water-quality | WaterQualityParamEquipment | `water_quality_param_equipment` | omit (OK) | OK |
| water-quality | SensorTemperatureLatest | `sensor_temperature_latest` | omit (OK) | BE-ONLY (legit projection) |
| water-quality | SensorTemperatureDaily | `sensor_temperature_daily` | omit (OK) | BE-ONLY (legit projection) |
| harvest | HarvestRecord | `harvest_records` | omit (OK) | OK (qualityGrade derived) |
| harvest | HarvestPlan | `harvest_plans` | omit (OK) | OK |
| species | Species | `species` | omit (OK) | OK |

All in-scope tables are per-tenant and correctly OMIT `schema:` (ADR-011). No `WRONG-SCHEMA-PLACEMENT` in this partition. Cross-tenant infra tables (`farm_audit_logs`, `outbox_events`, `tenant_erasure_audit`) correctly declare `schema:'farm'` (out of biology scope).

## Executive summary

The biology partition is structurally sound: every table is read via the federated `farm` subgraph and 21/23 are reached from `web/modules/farm-module` and/or `web/apps/aquamobil`; ADR-011 schema discipline is clean throughout. Two material gaps: (1) **quad-persisted tank count** — `tank_batches.currentQuantity`/`currentBiomassKg` mirror `totalQuantity`/`totalBiomassKg`, and `tanks.currentCount`/`equipment.currentCount` re-persist the same count again; this exact mirror drift caused the production 900-vs-719 count bug (now single-writer-patched, columns still redundant). (2) **field-capture tables have no product writer** — `lice_counts`, `treatment_applications`, `welfare_assessments`, `escape_incidents` expose `record*` GraphQL mutations that NO farm-module or aquamobil surface invokes; the regulatory report tabs prefill *from* these records but the "Fish Health capture" screen they cite does not exist, so the records-as-SSoT architecture is unfulfilled. Secondary: a dual mortality-count write (`mortality_records` + `tank_operations`) and stale JSONB snapshot sub-fields on `batches_v2`. Full matrix in Appendix A; 8 incidental defects in Appendix B.

## Findings (by severity)

### CRITICAL
_None in the biology partition._

### HIGH

#### DB-FARMPROD-HIGH-001 — Tank fish-count persisted in four columns across three tables
**Severity:** HIGH · **Layer:** 2 (batch-count SSoT invariant) · **State:** OPEN

The live fish count in a tank is persisted in FOUR places:
- `tank_batches.totalQuantity` (derived from `batchDetails[]`, the declared SSoT)
- `tank_batches.currentQuantity` (mirror)
- `tanks.currentCount` (mirror)
- `equipment.currentCount` (mirror)

**Evidence**
- `apps/farm-service/src/batch/services/tank-batch.service.ts:182-183` — `currentQuantity = totalQuantity; currentBiomassKg = totalBiomassKg`.
- `apps/farm-service/src/batch/services/tank-batch.service.ts:200-217` — same method writes `Tank.currentCount` / `Equipment.currentCount` from `totalQuantity`.
- `apps/farm-service/src/database/migrations/1801800000000-BackfillTankBatchCurrentQuantityMirror.ts:10-19` — documents the 900-vs-719 divergence (web read stale `currentQuantity`, mobile read correct `totalQuantity`).
- `apps/farm-service/src/tank/resolvers/tank.resolver.ts:362-364` — web `batchMetrics` still prefers `currentQuantity ?? totalQuantity` and `currentBiomassKg ?? totalBiomassKg`.

**Rule violated:** Domain invariant "any second table/column persisting batch counts is DUPLICATE; one physical owner per business count."

**Proposed fix direction**
- Tier-1: drop `tank_batches.currentQuantity`/`currentBiomassKg`; read `totalQuantity`/`totalBiomassKg` everywhere (mobile already does).
- Keep `tanks.currentCount`/`equipment.currentCount` only if a drift-invariant test enforces `= tank_batches.totalQuantity`; otherwise derive on read.

**Affected surface:** `tank-batch.service.ts`, `tank.resolver.ts:362-364`, `tank_batches`/`tanks`/`equipment` entities + migrations, web tank cards.
**Expected closer:** farm-expert WRITER (primary) + database-reviewer.

#### DB-FARMPROD-HIGH-002 — Field-capture regulatory tables have GraphQL `record*` mutations but no frontend writer
**Severity:** HIGH · **Layer:** 2 (parity — durable surface with no product counterpart) · **State:** OPEN

`lice_counts`, `treatment_applications`, `welfare_assessments`, `escape_incidents` are written only by `recordLiceCount` / `recordTreatmentApplication` / `recordWelfareAssessment` / `recordEscapeIncident` on `FieldCaptureResolver`. NO `web/modules/farm-module` hook/page and NO `web/apps/aquamobil` screen invokes any of these mutations (only occurrence in `web/` is the codegen type file). The regulatory report tabs submit via *separate* `Submit*Report` draft mutations and only *prefill* from these records; the "corrections go to Fish Health" capture UI the tabs reference is not wired.

**Evidence**
- `apps/farm-service/src/fish-health/resolvers/field-capture.resolver.ts:114-172` — the four `record*` mutations (the only writers).
- Grep `recordLiceCount|recordWelfareAssessment|recordEscapeIncident|recordTreatmentApplication` across `web/` (excluding `generated/`) → **0 matches**.
- `web/modules/farm-module/src/graphql/regulatory.operations.ts:173-264` — FE submits `SubmitSeaLiceReport` / `SubmitWelfareEvent` / `SubmitEscapeReport` (report drafts), not the capture mutations.
- `web/modules/farm-module/src/pages/reports/tabs/SeaLiceReportTab.tsx:300-302,428-433` — counts render read-only "when the platform has weekly lice_counts … corrections go to the source counts in Fish Health" — a source screen that does not exist.

**Consequence:** the operational records the assemblers read (`lakselus.assembler.ts`, `rensefisk.assembler.ts`, disease/welfare/escape assemblers) are empty from the product's perspective; operators re-key report values each period with no reuse or reconciliation. The records-as-SSoT design is non-functional. (Reports still submit via manual entry, so this is not data-loss → HIGH, not CRITICAL.)

**Proposed fix direction**
- Wire a Fish Health capture surface (farm-module and/or aquamobil field entry) that calls the `record*` mutations, OR
- If capture is deferred, track it as an explicit gap with owner+deadline; do not ship the "records SSoT" prefill copy that implies a non-existent screen.

**Affected surface:** `web/modules/farm-module/src/pages/reports/**`, a new fish-health capture page/hooks, `field-capture.resolver.ts`.
**Expected closer:** farm-expert + frontend-expert WRITER.

### MEDIUM

#### DB-FARMPROD-MEDIUM-001 — `batches_v2` JSONB value-objects carry stale-by-design snapshot sub-fields
**Severity:** MEDIUM · **Layer:** 2 · **State:** OPEN

`weight`, `feedingSummary`, `growthMetrics`, `mortalitySummary`, `fcr` are `jsonb` snapshots. `weight.actual.totalBiomass` is deliberately NOT trusted — biomass is derived from `currentQuantity × avgWeight` at read (`batch.entity.ts:407-419`), so the stored `totalBiomass` sub-field is a write-only stale value. The row is read at the object level via GraphQL (not DEAD), but individual sub-keys are stale.
**Evidence:** `apps/farm-service/src/batch/entities/batch.entity.ts:239-273,407-419`; `batch.types.ts:102-171`.
**Proposed fix:** replace stale JSONB sub-fields with typed derived resolvers, or document the authoritative source per sub-key. Correctness is preserved because the derive path wins.
**Expected closer:** farm-expert.

#### DB-FARMPROD-MEDIUM-002 — Mortality count dual-persisted in `mortality_records` and `tank_operations`
**Severity:** MEDIUM · **Layer:** 2 (batch-count SSoT invariant) · **State:** OPEN

One mortality event durably records its count in TWO tables: `mortality_records.count` (clinical detail record) and `tank_operations.quantity` (operation ledger, `operationType=MORTALITY`) — plus the `batches_v2.totalMortality` and `tank_batches.batchDetails[]` deltas. `mortality_records` and `tank_operations` are independent tables both carrying the same event's count with no invariant tying them.
**Evidence:** `apps/farm-service/src/batch/handlers/record-mortality.handler.ts:223-241` (save MortalityRecord) + `:249-271` (save TankOperation) + `:283` (Batch) + `:291` (applyBatchDelta).
**Mitigation:** both writes share one `queryRunner` transaction, so they cannot diverge at write time; drift risk is only on later independent edits/corrections (no dual-update guard).
**Proposed fix:** make `mortality_records` the clinical detail and derive/reference the ledger row (or vice-versa) so the count has one physical owner; add a reconciliation invariant. Cull uses the same pattern (`record-cull.handler`) — apply consistently.
**Expected closer:** farm-expert + database-reviewer.

### LOW

#### DB-FARMPROD-LOW-001 — `batch_feed_assignments` audit columns are write-only (no `@Field`)
**Severity:** LOW · **Layer:** 1 · **State:** OPEN
`createdBy`, `updatedBy`, `deletedBy` on `BatchFeedAssignment` carry `@Column` but no `@Field`, so they are written (soft-delete/audit) and never read anywhere. Inert audit hygiene — acceptable, but flag as WRITE-ONLY.
**Evidence:** `apps/farm-service/src/batch/entities/batch-feed-assignment.entity.ts:98-99,113-117`.
**Expected closer:** farm-expert (optional; expose or document).

## Cross-domain dependencies flagged
- DB-FARMPROD-HIGH-001: also invoke `database-reviewer` (column drop + drift-invariant test) and `multi-tenant-saas-expert` is not needed (per-tenant only).
- DB-FARMPROD-HIGH-002: also invoke `frontend-expert` (capture UI) and cross-reference the regulatory-reporting owner.
- `Batch.protocolId` / protocol-rate reads: per partition boundary, feed-side owned by `db-audit-farm-operations` — not double-reported here.

## Verdict
CONDITIONAL. Conditions: resolve DB-FARMPROD-HIGH-001 (drop/enforce duplicate count columns) and DB-FARMPROD-HIGH-002 (wire or explicitly track the field-capture writer surface).

---

## Appendix A — Provenance matrix

Legend — writer: FE-FORM | EVENT | SYSTEM | MIGRATION | NONE. read: GRAPHQL | BE-INTERNAL | NONE. fe: `<module>/<surface>` | AQUAMOBIL | NONE. class: OK | DEAD | WRITE-ONLY | BE-ONLY | DUPLICATE | SUSPECT. Standard audit columns (`id`, `tenantId`, `createdAt`, `updatedAt`, `version`) are OK across all tables and not repeated unless anomalous. Deep evidence appears on non-OK rows only.

### `batches_v2` (Batch) — verdict OK (read via `batch`/`batches`/`batchPerformance`/`batchHistory`/`batchTraceability`; FE `farm-module/production` + AQUAMOBIL)

| column | writer | read | fe | class |
|---|---|---|---|---|
| batchNumber | FE-FORM/SYSTEM(generateBatchNumber) | GRAPHQL | farm-module/production | OK |
| name, description, strain | FE-FORM | GRAPHQL | farm-module/production | OK |
| speciesId | FE-FORM | GRAPHQL | farm-module/production | OK |
| protocolId | FE-FORM | GRAPHQL | farm-module (feeding seam) | OK (feed side → db-audit-farm-operations) |
| inputType, batchType | FE-FORM | GRAPHQL | farm-module/production | OK |
| sourceType, sourceLocation | FE-FORM (cleaner) | GRAPHQL | farm-module/cleaner | OK |
| initialQuantity, currentQuantity | FE-FORM / SYSTEM(delta handlers) | GRAPHQL | farm-module + AQUAMOBIL | OK (batch-level count SSoT) |
| totalMortality, cullCount, harvestedQuantity | SYSTEM(mortality/cull/harvest) | GRAPHQL | farm-module/production | OK |
| totalFeedConsumed, totalFeedCost | SYSTEM(feeding) | GRAPHQL | farm-module/production | OK |
| retentionRate, sgr, costPerKg | SYSTEM(derived) | GRAPHQL | farm-module/production | OK |
| weight (jsonb) | SYSTEM(growth/feeding) | GRAPHQL | farm-module/production | OK (sub-field `actual.totalBiomass` write-only — MEDIUM-001) |
| fcr, feedingSummary, growthMetrics, mortalitySummary (jsonb) | SYSTEM | GRAPHQL | farm-module/production | OK (MEDIUM-001) |
| stockedAt, expectedHarvestDate, actualHarvestDate | FE-FORM/SYSTEM | GRAPHQL | farm-module/production | OK |
| supplierId, supplierBatchNumber, purchaseCost, currency | FE-FORM | GRAPHQL | farm-module/production | OK |
| arrivalMethod | FE-FORM | GRAPHQL | farm-module/production | OK |
| status, statusChangedAt, statusReason | SYSTEM(updateBatchStatus) | GRAPHQL | farm-module/production | OK |
| isActive, notes | FE-FORM/SYSTEM | GRAPHQL | farm-module/production | OK |
| createdBy, updatedBy | SYSTEM(user.sub) | GRAPHQL | farm-module (audit) | OK |

### `tank_batches` (TankBatch) — verdict OK w/ DUPLICATE cols (read via `tank.batchMetrics` + mobile projection; FE `farm-module/tanks` + AQUAMOBIL)

| column | writer | read | fe | class |
|---|---|---|---|---|
| tankId, tankName, tankCode | SYSTEM(applyBatchDelta) | GRAPHQL | farm-module/tanks + AQUAMOBIL | OK |
| primaryBatchId, primaryBatchNumber | SYSTEM(derived) | GRAPHQL | farm-module/tanks + AQUAMOBIL | OK |
| totalQuantity, totalBiomassKg | SYSTEM(derived from batchDetails[]) | GRAPHQL | AQUAMOBIL + farm-module | OK (tank count SSoT) |
| avgWeightG, densityKgM3 | SYSTEM(derived) | GRAPHQL | farm-module/tanks | OK |
| **currentQuantity** | SYSTEM(mirror=totalQuantity) | GRAPHQL(web pieces) | farm-module/tanks | **DUPLICATE** (HIGH-001) |
| **currentBiomassKg** | SYSTEM(mirror=totalBiomassKg) | GRAPHQL(web biomass) | farm-module/tanks | **DUPLICATE** (HIGH-001) |
| isMixedBatch | SYSTEM(derived length>1) | GRAPHQL | farm-module/tanks | OK |
| batchDetails (jsonb) | SYSTEM(SSoT) | GRAPHQL | farm-module/tanks | OK (per-tank count SSoT) |
| cleanerFishQuantity, cleanerFishBiomassKg, cleanerFishDetails | SYSTEM(cleaner handlers) | GRAPHQL | farm-module/cleaner-fish | OK |
| lastFeedingAt, lastSamplingAt, lastMortalityAt | SYSTEM | GRAPHQL(batchMetrics) | farm-module/tanks | OK |
| capacityUsedPercent, isOverCapacity | SYSTEM | GRAPHQL | farm-module/tanks | OK (over-capacity = legit admin override) |

### `tanks` (Tank) — verdict OK w/ one DUPLICATE col (read via `tank`/`tanks`/`tanksByDepartment`; FE `farm-module/tanks` + AQUAMOBIL useTanks)

| column | writer | read | fe | class |
|---|---|---|---|---|
| name, code, description | FE-FORM | GRAPHQL | farm-module/tanks + AQUAMOBIL | OK |
| departmentId, systemId, equipmentTypeId, equipmentTypeCode | FE-FORM | GRAPHQL | farm-module/tanks | OK |
| containerKind | FE-FORM (default TANK) | GRAPHQL | farm-module/setup | OK |
| temperatureSensorId | FE-FORM | BE-INTERNAL(WaterTemperatureService)+GRAPHQL | farm-module/setup | OK |
| regulatoryUnitId | FE-FORM | BE-INTERNAL(settefisk assembler)+GRAPHQL | farm-module/setup | OK |
| tankType, material, waterType | FE-FORM | GRAPHQL | farm-module/tanks | OK |
| diameter, length, width, depth, waterDepth, freeboard | FE-FORM | GRAPHQL | farm-module/tanks | OK |
| volume, waterVolume | SYSTEM(BeforeInsert/Update computeVolume) | GRAPHQL | farm-module/tanks | OK |
| maxBiomass, maxDensity | FE-FORM | GRAPHQL(capacityInfo) | farm-module/tanks | OK |
| currentBiomass | SYSTEM(feeding/growth path) | GRAPHQL(capacityInfo) | farm-module/tanks | OK (see INC-01) |
| **currentCount** | SYSTEM(applyBatchDelta mirror) | GRAPHQL | farm-module/tanks | **DUPLICATE** (HIGH-001) |
| waterFlow, aeration, location (jsonb) | FE-FORM | GRAPHQL | farm-module/tanks | OK |
| status, statusChangedAt, statusReason | SYSTEM(updateTankStatus) | GRAPHQL | farm-module/tanks | OK |
| isActive, notes, installationDate, lastMaintenanceDate, nextMaintenanceDate | FE-FORM | GRAPHQL | farm-module/tanks | OK |
| createdBy, updatedBy | SYSTEM | GRAPHQL | farm-module (audit) | OK |

### `tank_allocations` (TankAllocation) — verdict OK (allocation history; read via batch history/traceability; FE farm-module/production)
All columns (batchId/tankId/allocationType/allocationDate/quantity/avgWeightG/biomassKg/sourceTankId/densityKgM3/notes/allocatedBy + denormalized names + soft-delete) — writer SYSTEM(allocate/transfer/grading handlers), read GRAPHQL(batchHistory/batchTraceability) + BE-INTERNAL, fe farm-module/production → OK. (`tank?: Equipment` relation typing — INC-05.)

### `tank_operations` (TankOperation) — verdict OK (operation ledger; read via batchHistory + FCR calc)
All columns (operationType/operationDate/quantity/avgWeightG/biomassKg, mortality/cull/transfer/harvest detail groups, cleaner fields, pre/postOperationState jsonb, performedBy, soft-delete) — writer SYSTEM(all removal/transfer/harvest handlers), read GRAPHQL(batchHistory) + BE-INTERNAL(FcrCalculationService net-exited biomass), fe farm-module/production → OK. Ledger complements the batchDetails current-state SSoT (not a duplicate). Mortality count overlaps `mortality_records` → MEDIUM-002.

### `mortality_records` (MortalityRecord) — verdict OK w/ dual-count (read via health/mortality history; FE farm-module/production MortalityModal)
| column | writer | read | fe | class |
|---|---|---|---|---|
| batchId, tankId, pondId | FE-FORM | GRAPHQL | farm-module/production | OK |
| recordDate, **count** | FE-FORM | GRAPHQL | farm-module/production | OK (count also in tank_operations — MEDIUM-002) |
| estimatedBiomassLoss, dailyMortalityRate | SYSTEM/FE-FORM | GRAPHQL | farm-module/production | OK |
| cause, causeDetail, severity | FE-FORM | GRAPHQL | farm-module/production | OK |
| waterQualitySnapshot (jsonb), symptoms, behaviorObservations, physicalCondition | FE-FORM | GRAPHQL | farm-module/production | OK |
| actionsTaken, recommendations, labSampleTaken, labResults | FE-FORM | GRAPHQL | farm-module/production | OK |
| documents (jsonb) | FE-FORM | GRAPHQL | farm-module/production | OK |
| recordedBy, verifiedBy, verifiedAt, notes | FE-FORM/SYSTEM | GRAPHQL | farm-module/production | OK |

### `batch_locations` (BatchLocation) — verdict OK (multi-location; read via batch `locations` DataLoader field resolver; FE farm-module/production)
All columns (batchId/locationType/tankId/pondId/quantity/biomass/avgWeight/movedAt/movedBy/transferReason/previousLocationId/isCurrentLocation/exitedAt/notes) — writer SYSTEM(allocate/transfer handlers), read GRAPHQL(Batch.locations), fe farm-module/production → OK.

### `batch_documents` (BatchDocument) — verdict OK (read via Batch `documents`/`healthCertificates`/`importDocuments` DataLoaders; FE farm-module/production)
All columns (documentType/documentName/documentNumber/storagePath/storageUrl/originalFilename/mimeType/fileSize/issueDate/expiryDate/issuingAuthority/notes/isActive/createdBy) — writer FE-FORM(createBatch health/import docs), read GRAPHQL, fe farm-module/production → OK.

### `batch_feed_assignments` (BatchFeedAssignment) — verdict OK w/ write-only audit cols (read via Batch `feedAssignments`; FE farm-module useBatchFeedAssignments)
feedAssignments(jsonb)/isActive/notes/isDeleted/deletedAt — writer FE-FORM, read GRAPHQL, fe farm-module → OK. `createdBy`/`updatedBy`/`deletedBy` — no `@Field` → WRITE-ONLY (LOW-001).

### `growth_measurements` (GrowthMeasurement) — verdict OK (read via growthMeasurement(s)/growthAnalysis/latestGrowthMeasurement/batchGrowthHistory; FE farm-module/production GrowthTab)
All columns (batchId/tankId/pondId/measurementDate/type/method/sampleSize/populationSize/samplePercent/individualMeasurements jsonb/statistics jsonb/averageWeight/averageLength/weightCV/conditionFactor/growthComparison jsonb/performance/fcrAnalysis jsonb/estimatedBiomass/previousBiomass/biomassGain/suggestedActions jsonb/conditions jsonb/isVerified/verifiedBy/verifiedAt/measuredBy/notes/updateBatchWeight/isProcessed) — writer FE-FORM(recordGrowthSample)+SYSTEM(BeforeInsert derive)+SYSTEM(verify/updateBatchWeight), read GRAPHQL (full field coverage in `growth.operations.ts`), fe farm-module/production → OK.

### `health_events` (HealthEvent) — verdict OK (read via healthEvent(s)/healthEventsByBatch/critical/overdue/stats/batchHarvestEligibility; FE farm-module/health useHealthEvents)
All columns (batchId/tankId/pondId/title/description/eventType/eventDate/eventTime/diseaseCategory/diseaseName/severity/symptoms jsonb/affectedPopulation jsonb/treatment jsonb/isUnderTreatment/treatmentEndDate/withdrawalPeriodDays/earliestHarvestDate/isQuarantined/quarantine*/labResults jsonb/labConfirmed/vetConsultation jsonb/vetNotified/waterQualitySnapshot jsonb/relatedWaterQualityMeasurementId/status/resolvedDate/resolutionNotes/parentEventId/alertIncidentId/estimatedCost/currency/reportedBy/notes/attachments/followUpRequired/nextFollowUpDate) — writer FE-FORM(create/update + lifecycle mutations), read GRAPHQL + BE-INTERNAL(harvest eligibility, batchPerformance), fe farm-module/health → OK.

### `lice_counts` (LiceCount) — verdict: writer FE-UNREACHABLE (HIGH-002)
| column | writer | read | fe | class |
|---|---|---|---|---|
| siteId, tankId, batchId, countDate | (mutation) `recordLiceCount` | GRAPHQL(liceCounts) + BE-INTERNAL(lakselus.assembler) | NONE (no FE caller) | WRITE-path FE-unreachable |
| reportingYear, reportingWeek | SYSTEM(derived at write) | GRAPHQL + BE-INTERNAL | NONE | HIGH-002 |
| adultFemaleLice, mobileLice, attachedLice, fishSampled | (mutation) | GRAPHQL + BE-INTERNAL(report prefill) | NONE | HIGH-002 |
| seaTemperatureC, temperatureSource, countedBy, notes | (mutation) | GRAPHQL | NONE | HIGH-002 |

### `treatment_applications` (TreatmentApplication) — verdict: writer FE-UNREACHABLE (HIGH-002)
All columns (siteId/tankId/batchId/healthEventId/category/method/chemicalId/virkestoffType/styrkeVerdi/styrkeEnhet/mengdeVerdi/mengdeEnhet/wholeSite/pensCount/appliedAt/completedAt/veterinarianWorkerId/externalVetName/beskrivelse/recordedBy) — writer `recordTreatmentApplication` (no FE caller), read GRAPHQL(treatmentApplications) + BE-INTERNAL(assemblers), fe NONE → HIGH-002.

### `welfare_assessments` (WelfareAssessment) — verdict: writer FE-UNREACHABLE (HIGH-002)
All columns (siteId/tankId/batchId/assessedAt/fishSampled/gillScore/finScore/woundScore/deformityScore/assessedBy/notes) — writer `recordWelfareAssessment` (no FE caller), read GRAPHQL(welfareAssessments) + BE-INTERNAL, fe NONE → HIGH-002.

### `escape_incidents` (EscapeIncident) — verdict: writer FE-UNREACHABLE (HIGH-002)
All columns (siteId/tankId/batchId/detectedAt/speciesId/estimatedCount/avgWeightG/cause/causeDetails/recoveryOngoing/recoveredCount/status/varslingReportId/createdBy/notes) — writer `recordEscapeIncident`/`closeEscapeIncident` (no FE caller), read GRAPHQL(escapeIncidents) + BE-INTERNAL(rømming varsling assembler), fe NONE → HIGH-002.

### `water_quality_measurements` (WaterQualityMeasurement) — verdict OK (read via waterQuality/latest/chart/statistics/critical + by-system; FE farm-module/water-chemistry + AQUAMOBIL WaterQualityRecordPage)
| column | writer | read | fe | class |
|---|---|---|---|---|
| tankId, pondId, siteId, equipmentId | FE-FORM | GRAPHQL | farm-module/water-chemistry + AQUAMOBIL | OK |
| measuredAt, source, measuredBy | FE-FORM/SYSTEM | GRAPHQL | farm-module/water-chemistry | OK |
| parameters (jsonb) | FE-FORM | GRAPHQL | farm-module/water-chemistry | OK |
| temperature, dissolvedOxygen, pH, ammonia, nitrite | SYSTEM(BeforeInsert syncQuickAccessFields from parameters) | GRAPHQL | farm-module/water-chemistry | OK (denormalized — INC-04) |
| overallStatus, summary (jsonb) | SYSTEM(evaluation service) | GRAPHQL | farm-module/water-chemistry | OK |
| hasAlarm, alertRuleId, alertIncidentId | SYSTEM(alert integration) | GRAPHQL | farm-module | OK |
| sensorInfo (jsonb), relatedSensorReadingId | EVENT/SYSTEM(sensor correlation) | GRAPHQL + BE-INTERNAL | farm-module (audit link) | OK |
| batchId, idempotencyKey, notes, weatherConditions | FE-FORM/SYSTEM | GRAPHQL/BE-INTERNAL(idempotency) | farm-module | OK |

### `water_quality_parameter_configs` (WaterQualityParameterConfig) — verdict OK (read via parameter-config resolver; FE farm-module useParameterConfigs)
All columns (code/name/unit/dataType/precision/group/optimal|warning|critical Min/Max/speciesLimits jsonb/enumValues/chartColor/icon/displayOrder/isVisible/isRequired/isActive/chartAxisGroup/isQuickAccess/templateSource) — writer FE-FORM(create/update/bulk-from-template/reorder), read GRAPHQL + BE-INTERNAL(WaterQualityEvaluationService), fe farm-module/settings → OK.

### `water_quality_param_equipment` (WaterQualityParamEquipment) — verdict OK (read via param-equipment queries; FE farm-module useParamEquipmentMapping)
All columns (parameterConfigId/equipmentId/isActive/monitoringFrequency/sensorId/alertEnabled/notes) — writer FE-FORM(create/update/bulk-map/delete), read GRAPHQL, fe farm-module → OK.

### `sensor_temperature_latest` (SensorTemperatureLatest) — verdict BE-ONLY (legit projection read model)
tenantId/sensorId/temperatureC/measuredAt — writer EVENT(`SensorTemperatureProjectionListener` from sensor-service `SensorReading` NATS stream), read BE-INTERNAL(WaterTemperatureService feeding-rate calc), fe NONE → BE-ONLY (legitimate per aggregation-fed invariant; projection listener confirmed at `apps/farm-service/src/events/listeners/sensor-temperature-projection.listener.ts`).

### `sensor_temperature_daily` (SensorTemperatureDaily) — verdict BE-ONLY (legit projection read model)
tenantId/sensorId/day/sumC/minC/maxC/sampleCount/lastMeasuredAt/updatedAt — writer EVENT(same projection listener), read BE-INTERNAL(regulatory period temperature aggregate, RPT-005), fe NONE → BE-ONLY (legitimate; idempotency watermark `lastMeasuredAt`).

### `harvest_records` (HarvestRecord) — verdict OK (read via harvests/harvest/harvestsByBatch/harvestStatistics; FE farm-module + AQUAMOBIL RecordHarvestPage)
| column | writer | read | fe | class |
|---|---|---|---|---|
| recordCode, lotNumber | SYSTEM(generated) | GRAPHQL | farm-module + AQUAMOBIL | OK |
| batchId, harvestPlanId, tankId, pondId | FE-FORM | GRAPHQL | farm-module + AQUAMOBIL | OK |
| status, harvestDate | FE-FORM/SYSTEM | GRAPHQL | farm-module + AQUAMOBIL | OK |
| operation (jsonb), method | FE-FORM | GRAPHQL | farm-module | OK |
| quantityHarvested, totalBiomass, averageWeight, minWeight, maxWeight | FE-FORM | GRAPHQL | farm-module + AQUAMOBIL | OK |
| sizeDistribution (jsonb), productForm | FE-FORM | GRAPHQL | farm-module | OK |
| qualityClass | FE-FORM | GRAPHQL | farm-module | OK (stored quality SSoT) |
| qualityGrade (derived getter, no @Column) | — | GRAPHQL(derived) + BE-INTERNAL(stats group-by getter) | farm-module (legacy display) | OK (lossy alias — INC-03) |
| qualityControl (jsonb), qualityApproved | FE-FORM/SYSTEM | GRAPHQL | farm-module | OK |
| lotInfo (jsonb), yieldCalculation (jsonb), shipment (jsonb), customerDeliveries (jsonb) | FE-FORM | GRAPHQL | farm-module | OK |
| totalRevenue, harvestCost, currency | FE-FORM | GRAPHQL | farm-module | OK |
| mortalityDuringHarvest, rejectedQuantity, rejectionReason | FE-FORM | GRAPHQL | farm-module | OK |
| supervisorId, approvedBy, approvedAt, notes, attachments, updatedBy | FE-FORM/SYSTEM | GRAPHQL | farm-module | OK |

### `harvest_plans` (HarvestPlan) — verdict OK (read via harvestPlan queries; FE farm-module useHarvestPlans, harvestPlan.operations.ts)
All columns (planCode/name/description/batchId/status/harvestType/plannedDate/confirmedDate/window*/criteria jsonb/harvestMethod/productForm/estimates jsonb/financialProjection jsonb/logistics jsonb/customerOrder jsonb/qualityRequirements jsonb/actual*/approvedBy/approvedAt/createdBy/notes/attachments) — writer FE-FORM(create/update/approve/schedule/complete/cancel/postpone), read GRAPHQL, fe farm-module/harvest → OK.

### `species` (Species) — verdict OK (read via species/speciesByCode/speciesList/activeSpecies/speciesTags; FE farm-module useSpecies)
All columns (scientificName/commonName/localName/code/officialCode/description/category/waterType/family/genus/optimalConditions jsonb/growthParameters jsonb/harvestDaysPerInputType jsonb/growthStages jsonb/marketInfo jsonb/breedingInfo jsonb/status/isActive/isCleanerFish/cleanerFishType/tags jsonb/notes/imageUrl/supplierId/documents jsonb/createdBy/updatedBy/isDeleted/deletedAt/deletedBy) — writer FE-FORM(create/update/delete/restore), read GRAPHQL + BE-INTERNAL(batch expected-harvest calc, WQ species limits, report artskode), fe farm-module/setup → OK. `officialCode` read by regulatory assemblers (BE-INTERNAL) — OK.

---

## Appendix B — Incidental findings (in- and out-of-partition)

- **INC-01 (batch, latent):** `tank_batches.currentBiomassKg` is a count-path mirror, but `tank-batch.service.ts:190-199` explicitly leaves `Tank.currentBiomass` on the growth/feeding path — so the tank's biomass is fed by two unreconciled sources (batchDetails-derived vs feeding-growth). Documented deferred unification; latent divergence surface.
- **INC-02 (out-of-partition, doc drift):** `web/shared-ui/src/generated/graphql-types.ts` EXISTS on disk (it holds the farm subgraph types incl. the field-capture mutations), contradicting `.claude/knowledge/layer-1-react.md:44-46` which states the codegen output "does not exist on disk / codegen is orphaned." The SSoT knowledge shard is stale; the generated file is present. Recommend reconciling the layer-1-react SSoT.
- **INC-03 (harvest, accepted tradeoff):** `HarvestRecord.qualityGrade` is a lossy derived alias of `qualityClass` (`SUPERIOR→GRADE_A`, PREMIUM unreachable). Documented/accepted operator decision (RPT-007). `HarvestQualityStats.grade` in statistics inherits this collapse. Note only — no fix.
- **INC-04 (water-quality, denormalization):** `water_quality_measurements` duplicates `parameters.{temperature,dissolvedOxygen,pH,ammonia,nitrite}` into dedicated quick-access columns via `BeforeInsert/BeforeUpdate syncQuickAccessFields` (`water-quality-measurement.entity.ts:392-403`). Single-writer, intentional denormalization for indexed reads — acceptable, but a JSONB↔column duplicate to be aware of.
- **INC-05 (batch/tank, type smell):** relations `tank?: Equipment` are declared with `@ManyToOne('Tank')` in `tank-batch.entity.ts:100-102`, `tank-allocation.entity.ts:103-105`, `mortality-record.entity.ts:170-172` — the property is typed `Equipment` while the FK targets the `Tank`/`tanks` table. The Tank-vs-Equipment container duality (two tables model "container") is a latent modelling inconsistency; a wrong relation target would not be caught by the type. Cross-refs the equipment/tank owner.
- **INC-06 (hygiene):** dead commented-out `@OneToMany` relations in `batch.entity.ts:388-398`, `tank.entity.ts:559-560`, `species.entity.ts:560-567`. Remove or activate.
- **INC-07 (fish-health, read side of HIGH-002):** the field-capture READ queries (`liceCounts`, `treatmentApplications`, `welfareAssessments`, `escapeIncidents`) also have NO FE consumer — the report prefill runs server-side assemblers, not these GraphQL queries. So both read and write GraphQL surfaces of the four field-capture tables are FE-unreachable (GraphQL-without-FE on both directions), reinforcing HIGH-002.
- **INC-08 (batch, parallel enums):** mortality reason is modeled by TWO enums — `MortalityCause` (`mortality_records.cause`) and `MortalityReason` (`tank_operations.mortalityReason`) — requiring the `isMortalityCause` mapping guard in `record-mortality.handler` to reconcile the same physical event across both tables (history: FARM-HIGH-054/052). Drift risk between the two vocabularies; pairs with MEDIUM-002 (dual-count).

## References
- `.claude/agents/_shared/db-audit-methodology.md`; `.claude/knowledge/layer-{1,2}-*.md`
- CLAUDE.md batch-count SSoT invariant; memory `project_batch_lifecycle_ssot`, `project_harvest_qualitygrade_migration_outage_2026_07_07`, `project_farm_tank_capacity_rule`
- `apps/farm-service/src/batch/services/tank-batch.service.ts`; migration `1801800000000-BackfillTankBatchCurrentQuantityMirror.ts`
- `apps/farm-service/src/fish-health/resolvers/field-capture.resolver.ts`; `web/modules/farm-module/src/graphql/regulatory.operations.ts`
- Prior: `docs/reviews/2026-06-24-graphql-fe-be-contract-drift-audit.md`; `docs/reviews/orphan-findings.md`
</content>
