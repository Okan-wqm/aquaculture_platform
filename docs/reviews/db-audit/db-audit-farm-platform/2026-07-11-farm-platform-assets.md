# DB Audit — Farm Assets, Ops & External-Data Partition (Lane-D / FARMPLAT)

**Cycle date:** 2026-07-11
**Auditor:** db-audit-farm-platform (Lane-D, secondary reviewer — review-only)
**Partition:** `apps/farm-service` domains — farm, site, department, equipment, maintenance, task, worker, document, regulatory, compliance, scheduler, weather, marine-data, sentinel-hub, mobile-command, mobile-dashboard, ai-insights, system; infra dirs outbox/, events/, database/. FE: `web/modules/farm-module`, `web/modules/dashboard` farm-fed widgets; EXTERNAL ingests (Open-Meteo weather/marine, CMEMS, Sentinel Hub).

## Scope

Provenance / read-exposure / FE-reachability trace over the 35 `@Entity` classes owned by this partition, reconciled against `MODULE_SCHEMAS['farm'].infrastructureTables` (`libs/backend-common/src/database/schema-manager.service.ts:333-342`). All farm-service resolvers compose into the single federated `farm` subgraph (`infrastructure/apollo-router/subgraphs.json`), so GraphQL reads here are product-reachable. Read-only over source; the report is the only write surface.

## Executive summary

The partition is largely healthy: schema placement is correct on every table (per-tenant tables omit `schema:`; the three farm-schema infra ledgers — `outbox_events`, `farm_audit_logs`, `tenant_erasure_audit` — declare it, appear in `infrastructureTables`, and carry NO per-tenant source-write guard, satisfying the ADR-011 infra-ledger invariant and the 2026-06-30 incident guard-placement rule). External weather/marine columns all have FE consumers (the `MARINE_OBSERVATIONS_QUERY` selects every column), so the external-data-consumer invariant holds. Three real defects: (1) **`farm_documents`** — a full document-management table (lifecycle FSM, scan state, presign fields) is modelled and migrated but has NO product write/read path (only the MinIO orphan-cleanup live-path collector reads `objectKey`); the whole subsystem is unreachable. (2) **`farm_workers`** persists six NOT-NULL, AES-256-GCM-encrypted PII columns (`nationalId`, `dateOfBirth`, `address`, `baseSalary`, `employmentType`, `department`) filled with hardcoded placeholders by the create handler — never collected from the user, never surfaced: write-only encrypted junk duplicating hr-service `employees`. (3) **`equipment.currentCount`/`currentBiomass`** are derived mirrors participating in the quad-persisted tank fish-count (confirms wave-1 DB-FARMPROD-HIGH-001). Incidental: ai-insights surfaces MCP outputs computed from hardcoded default parameters instead of real batch/tank data.

## Findings (by severity)

### HIGH

#### DB-FARMPLAT-HIGH-001 — `farm_documents` document-management table has no product write/read path (orphan subsystem)

**Severity:** HIGH · **Layer:** 2 (dead structure / reachability) · **State:** OPEN

**Evidence**

- `apps/farm-service/src/document/entities/farm-document.entity.ts:57-211` — `FarmDocument` is a full `@ObjectType()` with a 6-state lifecycle FSM (`FarmDocumentState`), `scanState`, presign bookkeeping (`bucket`, `objectKey`, `uploadExpiresAt`, `etag`, `checksumSha256`), retention + `legalHold`, and a 10-value `FarmDocumentOwnerType` (CHEMICAL/FEED/BATCH/SITE/SUPPLIER/EQUIPMENT/TANK/WORKER/…).
- `apps/farm-service/src/document/document.module.ts:6-10` — module only does `TypeOrmModule.forFeature([FarmDocument])` + re-export; no resolver/controller/service/handler.
- Whole-service grep for `FarmDocument` → 8 files: entity, module, app.module, migration `1800800000000-CreateFarmDocuments.ts`, manifest, and `common/file-cleanup/farm-document-path.provider.ts`. NONE writes/inserts a row, presigns an upload, or lists documents for the product.
- `apps/farm-service/src/common/file-cleanup/farm-document-path.provider.ts:18-31` — the ONLY reader: `collectLivePaths()` selects `objectKey` to protect live objects from the MinIO orphan sweep. Because nothing writes `farm_documents`, this live-set is always empty.

**Rule violated**
Lane-D methodology `ORPHAN-TABLE` (no meaningful write/read/FE role). CLAUDE.md architectural-approach (a modelled-but-unwired subsystem is dead weight; document/attachment columns must be reachable through the storage abstraction and product surface).

**Proposed fix direction**

- Either wire the intended unified document flow (presign mutation + list/query resolver + upload finalize handler routing every setup aggregate through `farm_documents`), retiring the legacy per-domain paths (`chemical-document-path.provider.ts`, `batch_documents`); OR
- If the unified store is abandoned, drop `farm_documents` + its migration and the `FarmDocumentPathProvider` so the orphan sweep isn't gated on an empty table.
- Latent risk to name in the fix: an empty live-path set makes the MinIO orphan-cleanup treat any object in the farm-document bucket as deletable.

**Affected surface (ripple set)**
`apps/farm-service/src/document/**`, `apps/farm-service/src/common/file-cleanup/**`, `apps/farm-service/src/scheduler/minio-orphan-cleanup*`, migration `1800800000000-CreateFarmDocuments.ts`, FE `web/modules/farm-module/src/pages/production/components/DocumentUploadSection.tsx` + `hooks/useFileUpload.ts`.

**Expected closer** farm-expert WRITER mode (primary owner of `apps/farm-service`).

#### DB-FARMPLAT-HIGH-002 — `equipment.currentCount` / `currentBiomass` are denormalized mirrors of the quad-persisted tank fish-count

**Severity:** HIGH · **Layer:** 2 (duplicate structure) · **State:** OPEN

**Evidence**

- `apps/farm-service/src/equipment/entities/equipment.entity.ts:303-306` — `currentBiomass` "batch'lerden hesaplanır", `currentCount` "Mevcut adet - tank için".
- `apps/farm-service/src/equipment/services/tank-equipment-adapter.service.ts:148` — `equipment.currentCount = tank.currentCount;` (equipment row mirrors the tank row).
- `apps/farm-service/src/farm-stock/farm-stock-projection.service.ts:49-50` — declares the SSoT: "Count derives from `tank_batches` (the SSoT) only. `currentCount` is now a derived mirror (single writer)".
- Physical copies of the same datum: `tank_batches.totalQuantity` (SSoT) → `tanks.currentCount` → `equipment.currentCount`, plus `batches_v2.currentQuantity`.

**Rule violated**
Lane-D `DUPLICATE` / `DUPLICATE-STRUCTURE`. Confirms and extends wave-1 **DB-FARMPROD-HIGH-001** (quad-persisted tank fish-count) from the equipment side.

**Proposed fix direction**

- Mitigated but not eliminated: a single-writer path now exists. Prefer removing the equipment-side physical columns and resolving `currentCount`/`currentBiomass` on read from `tank_batches`, or formally documenting them as a read-model projection with the single writer named in a test invariant.

**Affected surface (ripple set)**
`equipment.entity.ts`, `tank-equipment-adapter.service.ts`, `list-equipment.handler.ts:418,441`, `farm-stock-projection.service.ts`, `equipment/dto/equipment.response.ts:345`.

**Expected closer** farm-expert WRITER mode (coordinated with the DB-FARMPROD-HIGH-001 owner — cross-lane).

### MEDIUM

#### DB-FARMPLAT-MEDIUM-001 — `farm_workers` persists 6 NOT-NULL encrypted PII columns filled with hardcoded placeholders (write-only, never read)

**Severity:** MEDIUM · **Layer:** 2 (write-only accumulation + duplicate structure) · **State:** OPEN

**Evidence**

- `apps/farm-service/src/worker/entities/worker.entity.ts:93-135` — `contactInfo`, `address`, `dateOfBirth`, `nationalId` (all AES-256-GCM encrypted), `employmentType`, `department`, `baseSalary` are NON-nullable (required).
- `apps/farm-service/src/worker/dto/create-worker.input.ts:5-45` — the create DTO only accepts firstName, lastName, email, phone, position, isVeterinarian, veterinaryLicenseNumber. None of the above.
- `apps/farm-service/src/worker/handlers/create-worker.handler.ts:74-90` — the handler hardcodes `address {street:'-',city:'-',state:'-',postalCode:'-',country:'TR'}`, `dateOfBirth:'1990-01-01'`, `nationalId:'-'`, `employmentType:'full_time'`, `department:'operations'`, `baseSalary:0` to satisfy NOT NULL.
- `apps/farm-service/src/worker/worker.resolver.ts:31-45` — `WorkerResponse` never returns `nationalId`, `dateOfBirth`, `address`, `baseSalary` (only `department`, which is always the constant `'operations'`).
- FE `web/modules/farm-module/src/pages/setup/tabs/WorkersTab.tsx` — no reference to nationalId/dateOfBirth/baseSalary/address.

**Rule violated**
Layer-2 defect-catalog (write-only accumulation / paid storage with zero product value) + DRY (duplicates hr-service `employees` shape). GDPR data-minimisation: encrypting and storing a placeholder `nationalId`/`dateOfBirth` is cost without purpose.

**Proposed fix direction**

- Drop the unused PII columns from `farm_workers` (blue-green: stop writing → drop), OR make them nullable and stop synthesising placeholders. `farm_workers` should model only what the farm feature actually captures (name/email/phone/position/department/vet-credential).

**Affected surface (ripple set)**
`worker/entities/worker.entity.ts`, `worker/handlers/create-worker.handler.ts`, `worker/handlers/update-worker.handler.ts`, `worker/dto/*`, a new migration.

**Expected closer** farm-expert WRITER mode.

### LOW

_None beyond the incidental hygiene items in Appendix B._

## Cross-domain dependencies flagged

- **Wave-1 DB-FARMPROD-HIGH-002 (Fish-Health capture) — report-side provenance established.** The regulatory report/draft persistence layer is correctly wired: `report-prefill.resolver.ts` → `GetReportPrefillQuery` assembles a per-(site, type, period) draft with per-field provenance (`RegulatoryReportDraft.fieldMeta: ReportFieldMeta[]`, `regulatory-report-draft.entity.ts:92-95`); FE consumes it via `regulatory.operations.ts` + `regulatory-drafts.operations.ts` + the reports pages/tabs. The RECORDS-class fields of a SEA_LICE / welfare / escape draft source from the fish-health domain (`lice_counts`, `health_events`, `welfare_assessments`, `escape_incidents` — NOT this partition). If the FE "Fish Health capture" screen is unwired, those fields carry no RECORDS provenance and the draft marks them `MANUAL_REQUIRED` for hand-entry — the report side is honest (persists an incomplete draft), the gap is upstream in fish-health capture. Recommend the fish-health lane (`db-audit-farm-prod` / farm-expert) confirm the capture surface writes `lice_counts` for SEA_LICE.
- **DB-FARMPLAT-HIGH-002** — recommend the DB-FARMPROD lane co-own the equipment-side mirror removal.

## Verdict

**CONDITIONAL** — partition is sound on schema placement, infra-ledger guards, and external-data consumers. Two HIGH structural defects (orphan `farm_documents` subsystem; equipment-side fish-count duplication) and one MEDIUM (write-only placeholder PII in `farm_workers`) must be triaged by the primary owner (farm-expert). No CRITICAL / cross-tenant / RLS defect found in this partition.

## References

- Methodology: `.claude/agents/_shared/db-audit-methodology.md`
- Layer knowledge: `layer-1-typeorm.md`, `layer-2-patterns.md`, `layer-2-defect-catalog.md`
- ADR-011 (schema ownership), ADR-006 (outbox/events)
- Registry: `MODULE_SCHEMAS` in `libs/backend-common/src/database/schema-manager.service.ts`
- Cross-lane: wave-1 DB-FARMPROD-HIGH-001 (quad-persist), DB-FARMPROD-HIGH-002 (fish-health capture)
- Prior: `docs/reviews/orphan-findings.md`, `docs/reviews/farm-expert/`

---

## Appendix A — Provenance matrix

Legend — writer: FE-FORM | EVENT | SYSTEM | EXTERNAL | MIGRATION | NONE. read: GRAPHQL | REST | BE-INTERNAL | NONE. class: OK | DEAD | WRITE-ONLY | BE-ONLY | UI-WITHOUT-DB | DUPLICATE | SUSPECT. Deep evidence is given only on non-OK rows.

### farms (Farm) — federated `@key(id)`

All columns OK. writer FE-FORM (createFarm deprecated; edit via farm.resolver mutations) / SYSTEM (version, audit cols). read GRAPHQL (farm.resolver, federated). fe farm-module setup/MapView. Note `ponds` OneToMany is READ-ONLY LEGACY (createPond/createFarm @deprecated + throw) — intentional, not a defect. `location` jsonb OK.

### ponds (Pond)

All columns OK. writer FE-FORM (legacy) / SYSTEM. read GRAPHQL (top-level `pond` query). fe farm-module. Legacy write surface deprecated but readable — OK.

### sites (Site)

All columns OK. writer FE-FORM (SiteFormModal via site.resolver → SiteResponse). read GRAPHQL. fe farm-module setup (SiteContactsSection, site pages). `lokalitetsnummer` (int, nullable) is the RPT-015 SSoT for regulatory reports — read by report assembly (BE-INTERNAL) + GRAPHQL. `facilities`/`settings`/`location`/`address`/`metadata` jsonb OK. Soft-delete cols OK.

### site_contacts (SiteContact)

All columns OK. writer FE-FORM (SiteFormModal contact fields, Scope-A Phase 4.4.3 → SiteContactsSection). read GRAPHQL. fe farm-module setup/SiteContactsSection.tsx.

### departments (Department)

All columns OK. writer FE-FORM (department.resolver → DepartmentResponse). read GRAPHQL. fe farm-module (useDepartments). `managerName` denormalized — OK.

### equipment_types (EquipmentType) · sub_equipment_types (SubEquipmentType)

Reference data. writer MIGRATION/seed (isSystem rows) + FE-FORM (tenant custom types). read GRAPHQL (equipment.resolver, useEquipmentParameters). `specificationSchema` jsonb drives dynamic FE forms — OK.

### equipment (Equipment)

Most columns OK (writer FE-FORM via equipment.resolver → EquipmentResponse; read GRAPHQL; fe farm-module equipment/tanks pages). **Non-OK:**

- `currentCount` — **DUPLICATE** — see DB-FARMPLAT-HIGH-002. Derived mirror (`tank-equipment-adapter.service.ts:148`).
- `currentBiomass` — **DUPLICATE** — same, derived from batches.
- `temperatureSensorId` — OK/BE-ONLY (soft cross-service ref to sensor-service; WaterTemperatureService reads it). `specifications`/`location`/`maintenanceSchedule` jsonb OK. `subEquipmentCount` denormalized counter — OK.

### equipment_systems (EquipmentSystem) · sub_equipment (SubEquipment)

All columns OK. writer FE-FORM (SubEquipmentSection; equipment-system junction via risk-mapping UI). read GRAPHQL (sub-equipment.resolver → SubEquipmentResponse). `criticalityLevel`/`isPrimary`/`role` OK.

### feeder_calibrations (FeederCalibration)

All columns OK. writer FE-FORM (FeederCalibrationSection). read GRAPHQL (useFeederCalibration). fe farm-module setup.

### maintenance_schedules (MaintenanceSchedule)

All columns OK. writer FE-FORM + SYSTEM (execution counters/metrics updated by markCompleted). read GRAPHQL (maintenance-schedule.resolver). fe farm-module maintenance pages. `metrics`/`recurrenceRule`/`checklistTemplate`/`requiredMaterials`/`alertSettings` jsonb OK. `autoGenerateWorkOrder` drives work-order generation.

### work_orders (WorkOrder)

All columns OK. writer FE-FORM + SYSTEM (auto-generated from schedules; lifecycle timestamps). read GRAPHQL (work-order.resolver). fe farm-module maintenance (GenerateWorkOrderButton, CompleteMaintenanceModal). `checklist`/`usedMaterials`/`laborRecords`/`costSummary`/`relatedAsset` jsonb OK. `attachments` simple-array OK (string keys). `relatedHealthEventId`/`relatedAlertIncidentId` soft refs — OK.

### spare_parts (SparePart)

All columns OK. writer FE-FORM. read GRAPHQL (spare-part.resolver). fe farm-module maintenance. Stock counters (quantity/minStock/reorderPoint) OK.

### tasks (Task)

All columns OK. writer FE-FORM (task.resolver + mobile create-task responder) / SYSTEM (auto-generated from recurring templates + auto-rules). read GRAPHQL. fe farm-module tasks pages. `checklistItems.completed` is a documented legacy field (FARM-HIGH-057) read+migrated by the normaliser, never re-emitted — benign, not a finding. `completedAt`/`completedBy` nulled on reopen (FARM-HIGH-056). `notes`/`tags` jsonb OK.

### auto_rules (AutoRule) · recurring_templates (RecurringTemplate)

All columns OK. writer FE-FORM (AutoRulesTab, RecurringTab). read GRAPHQL (auto-rule.resolver, recurring-template.resolver; useAutoRules). SYSTEM writes `lastTriggered`/`triggerCount`/`lastGenerated`/`nextGeneration`. `timezone` per-template (Phase 5.5) OK.

### farm_workers (Worker)

Non-OK cluster — see DB-FARMPLAT-MEDIUM-001:

- `nationalId`, `dateOfBirth`, `address`, `baseSalary`, `employmentType` — **WRITE-ONLY** (hardcoded placeholders at `create-worker.handler.ts:74-90`; never in WorkerResponse; never in FE).
- `department` — BE-ONLY-ish (written constant `'operations'`, read by WorkerResponse but never user-set).
- `contactInfo` — partial (only `.phone` surfaced; `.email` duplicates the `email` column; emergency\* write-only).
  OK columns: `firstName`, `lastName`, `email` (+ `emailHash` blind index, BE-INTERNAL uniqueness), `position`, `isVeterinarian`, `veterinaryLicenseNumber`, `employeeNumber`, `status`, `hireDate`. writer FE-FORM (WorkersTab → worker.resolver). read GRAPHQL (workers query). fe farm-module setup/WorkersTab. `veterinaryLicenseNumber`/`isVeterinarian` feed RPT-011 treatment attribution.

### farm_documents (FarmDocument)

**ORPHAN-TABLE — see DB-FARMPLAT-HIGH-001.** writer NONE (no product insert path). read BE-INTERNAL only (`FarmDocumentPathProvider.collectLivePaths()` reads `objectKey` for MinIO orphan cleanup). fe NONE. Every column (state FSM, scanState, bucket/objectKey, checksumSha256, etag, retentionUntil, legalHold, …) is unreachable. Note: `bucket`+`objectKey` design correctly uses the storage abstraction shape (not raw paths) — the storage invariant is not violated; the table is simply unwired.

### regulatory_settings (RegulatorySettings)

All columns OK. writer FE-FORM (regulatory.resolver settings mutation). read GRAPHQL (non-secret fields) + BE-INTERNAL (Mattilsynet/Maskinporten signing). `maskinportenClientId`/`maskinportenPrivateKeyEncrypted` — encrypted, NO `@Field` (secrets correctly not surfaced) → BE-ONLY, OK. `autoSubmitPolicies` jsonb drives scheduler opt-in — OK. Legacy `site_locality_mappings` + `slaughter_approval_number` already dropped (Phase 4 dedup migrations) — good de-duplication.

### slaughter_facilities (SlaughterFacility)

All columns OK. writer FE-FORM. read GRAPHQL (slaughter-facility.resolver). SSoT for slaughter approval number (replaced regulatory_settings column). fe farm-module reports/setup.

### biomass_reports (BiomassReport)

All columns OK. writer FE-FORM (createBiomassReport mutation; replaced the old console.log+setTimeout mock, Phase 2.1). read GRAPHQL (biomass-report.resolver; useBiomassReports). fe farm-module reports (BiomassReportTab). `report_data` jsonb typed `BiomassReportPayload` — OK. Terminal-state immutability enforced. GDPR-retained under Art 17(3)(b) carve-out (tracked in tenant_erasure_audit.retainedRowsByTable).

### regulatory_reports (RegulatoryReport)

All columns OK. writer FE-FORM (interactive submit) + SYSTEM (draft auto-submit + retry sweep). read GRAPHQL (regulatory-report.resolver — report-history tabs; replaced mock data, FARM-HIGH-125). `payload` jsonb = exact Mattilsynet wire payload. Retry-pipeline cols (`attemptCount`/`nextAttemptAt`/`failureClass`) SYSTEM-written, read by sweep — OK. `referanse`/`feilmelding` nullable to clear on resubmit — OK.

### regulatory_report_drafts (RegulatoryReportDraft)

All columns OK. writer SYSTEM (scheduler assembly, ON CONFLICT DO NOTHING) + FE-FORM (`manualOverrides`, approve). read GRAPHQL (regulatory-report-draft.resolver + report-prefill). fe farm-module reports (drafts). `assembledPayload`/`fieldMeta`/`manualOverrides` jsonb OK. `submittedReportId` links to regulatory_reports — OK.

### tenant_erasure_audit (TenantErasureAuditEntity) — schema:'farm' infra

All columns OK / BE-ONLY. writer SYSTEM (TenantErasureService.confirm). read BE-INTERNAL (re-confirm idempotency reconstructs ErasureResult) + GraphQL erasure result. GDPR Art-17 evidence ledger; PK=tenantId enforces one-erasure-per-tenant. `retainedRowsByTable`/`retainedRowsAnonymised` (Art 17(3)(b) carve-out) OK. Correctly in infrastructureTables; no source-write guard (infra invariant OK).

### weather_observations (WeatherObservation) · marine_observations (MarineObservation)

All columns OK — **EXTERNAL invariant satisfied.** writer EXTERNAL (Open-Meteo via WeatherSyncService.upsert*, `weather-sync.service.ts:164-285`). read GRAPHQL (weather.resolver: weatherObservations/marineObservations/currentWeather/weatherForecast). fe farm-module (useWeather.ts hooks, SiteWeatherSection). Every marine column (incl. swellWave*, oceanCurrent\*, seaSurfaceTemperature) is selected by `MARINE_OBSERVATIONS_QUERY` (useWeather.ts:104-123) — no write-only external column. `currentWeather` projects a subset but the full entity remains reachable via the list query.

### weather_settings (WeatherSettings)

All columns OK. writer FE-FORM (updateWeatherSettings) + SYSTEM (lastSyncedAt on sync). read GRAPHQL (weatherSettings). fe farm-module (WeatherSettingsModal). get-or-create on fail-closed `runInTenantTransaction` (FARM-HIGH-060) — correct boundary.

### sentinel_hub_settings (SentinelHubSettings)

All columns OK. writer FE-FORM (save credentials) + SYSTEM (usageCount/lastUsed bumped, `sentinel-hub.service.ts:168-169`). read GRAPHQL (sentinel-hub.resolver — status/credentials/configured, masked). fe farm-module settings (SentinelHubSettingsPage). `clientId`/`clientSecret`/`instanceId` AES-256-GCM encrypted; `accessToken` @HideField (SEC-C14) — secrets correctly gated. EXTERNAL Copernicus/Sentinel proxied server-side.

### farm_mobile_command_receipts (FarmMobileCommandReceipt)

All columns OK / BE-ONLY. writer SYSTEM (mobile-command idempotency ledger; registered in batch/harvest/feeding/task modules). read BE-INTERNAL (dedup replay of `responsePayload` on client retry). fe AQUAMOBIL (indirect — dedup guarantees idempotent mobile writes). Per-tenant cloned; unique (tenantId, clientCommandId). Legitimate idempotency infra.

### systems (System) · sub_systems (SubSystem)

All columns OK. writer FE-FORM (system.resolver → SystemResponse). read GRAPHQL. fe farm-module setup (equipment hierarchy). Self-referencing parent/child (System) exposed via GraphQL. `totalVolumeM3`/`maxBiomassKg`/`tankCount` capacity denormals OK. Soft-delete cols OK.

### outbox_events (FarmOutbox) — schema:'farm' infra

OK / BE-ONLY. writer SYSTEM (transactional outbox insert in business txns). read BE-INTERNAL (OutboxWorker poll → NATS). `OutboxEntityBase` columns; `synchronize:false` (migration-owned). In infrastructureTables; no source-write guard — infra invariant OK. `farm_outbox` (legacy) is compat-only, no entity of its own, also in the list.

### farm_audit_logs (AuditLog) — schema:'farm' infra

OK / BE-ONLY. writer SYSTEM (AuditLogService.logWithManager, transactional). read BE-INTERNAL (audit queries) + anonymised (not deleted) on erasure. `legalHold` mirrors a BEFORE-DELETE trigger (AUDITTRAIL-HIGH-005). Cross-tenant by design; correctly `schema:'farm'` + in infrastructureTables + NO source-write guard (the 2026-06-30 incident invariant — verified correct).

### code_sequences (CodeSequence)

OK / BE-ONLY. writer SYSTEM (code generation, FOR UPDATE lock). read BE-INTERNAL (next-code). Per-tenant (omits schema:), in `tables` array — correct placement. Unique (tenantId, entityType, year).

### Domains with no owned entity

- **scheduler/** — feeding-scheduler, cron-jobs, minio-orphan-cleanup: SYSTEM writers into other domains' tables + the orphan sweep. No own columns.
- **marine-data/** — CMEMS tile/point/AOI REST proxy (`api/internal/marine`, JwtAuthGuard). No DB table (pass-through). EXTERNAL third-party; nothing persisted.
- **mobile-dashboard/** — read-only CQRS (`get-todays-daily-ops-counts`, `get-stock-events-summary`) over MortalityRecord/TankOperation/DailyFeedingExecution/WaterQualityMeasurement via `runInTenantRead` (fail-closed boundary, FARM-HIGH-060). No own columns.
- **ai-insights/** — MCP read-only aggregation (see Appendix B). No DB writes.
- **events/** — NATS listeners projecting into farm-stock / sensor-temperature read models. No own columns.

---

## Appendix B — Incidental findings (operator directive 2026-07-11)

Recorded per the mandate: every deficiency noticed while tracing, including outside partition scope.

**B1 — ai-insights surfaces AI outputs computed from hardcoded default parameters, not real farm data (MEDIUM, correctness/product-integrity).**
`apps/farm-service/src/ai-insights/services/ai-insights.service.ts:145-163` (`getBatchGrowthPrediction` passes `currentWeightG:100, currentQuantity:10000, sgr:2.0` for every batch) and `:271-288` (`getFeedingAdvice` passes `feedKg:5.0, biomassKg:500, tankVolumeM3:50, temperature:22, currentPH:7.5` for every tank). Comments admit "in a production setup these would come from the batch entity" / "In production, these would be fetched from the tank and batch entities." The federated `farm` subgraph exposes these via ai-insights.resolver; the FE dashboard therefore renders growth/feeding "insights" identical for every batch/tank, decoupled from the tenant's real data. Root-cause fix: resolve batch/tank/WQ inputs from the DB before the MCP call. Owner: farm-expert / ai lane.

**B2 — `worker.resolver.ts` uses `(w: any)` and `as any`/`as` casts (LOW, type erosion — CLAUDE.md ban).**
`apps/farm-service/src/worker/worker.resolver.ts:30-31` — `ListWorkersQuery` result is `as Array<Record<string, unknown>>` then `.map((w: any) => …)`; `createWorker`/`updateWorker` use `as Worker`. `@typescript-eslint/no-explicit-any` is error-level in domain code; fix the query-handler return type and drop the casts.

**B3 — `farm_workers` duplicates the hr-service `employees` PII model (MEDIUM, DRY/duplicate-structure — folds into DB-FARMPLAT-MEDIUM-001).**
The entity comment states it is "separate from HR service's 'employees' table"; it re-implements the encrypted-PII column set (nationalId/DOB/address/salary/contactInfo blind-index) but the farm feature uses almost none of it. Two divergent PII models for "a person who works here" is a duplication risk; if farm workers ever need real HR data, prefer an eventual-consistency projection from hr-service rather than a second encrypted PII store.

**B4 — Marine `currentWeather` response omits 4 marine columns the entity persists (LOW, benign partial projection).**
`weather.resolver.ts:110-127` `CurrentWeatherResponse` drops `swellWaveDirection`, `swellWavePeriod`, `oceanCurrentVelocity`, `oceanCurrentDirection`. Not write-only (the `marineObservations` list query returns them), so no data is stranded — noted for completeness only.

**B5 — Farm CLAUDE.md tracked drift confirmed still open (LOW, doc/enforcement).**
`apps/farm-service/CLAUDE.md` notes the schema-routing architecture spec's `schema:'farm'` allowlist "currently only names the outbox" while `farm_audit_logs` + `tenant_erasure_audit` also legitimately declare `schema:'farm'` (ORPHAN-MEDIUM-118). Verified: both entities do declare `schema:'farm'` and are in `infrastructureTables`; the allowlist under-lists them. Enforcement-only gap, no runtime defect.
