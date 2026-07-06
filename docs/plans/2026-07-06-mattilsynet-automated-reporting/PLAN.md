# Mattilsynet Automated Regulatory Reporting — End-to-End Plan

Date: 2026-07-06 · Status: PROPOSED · Owner: farm-service / regulatory domain
API reference (durable, in-repo): `docs/integrations/mattilsynet-reporting-api.md`

## 0. Goal

The Norwegian authorities (Mattilsynet weekly/monthly APIs, Fiskeridirektoratet monthly biomass
form) require data the platform already owns: standing biomass by species, stockings, mortality by
cause, slaughter, feed consumption, transfers, water temperature, treatments, cleaner fish.
Today the report forms are **manual data entry with best-effort client-side prefill**. The goal is
an **automated pipeline**: every government-required field is sourced from its platform SSoT when
one exists; sensor-backed fields (temperature) resolve from the sensor projection with manual
fallback; only data the platform genuinely does not hold is entered manually — and where that data
is operational (lice counts, welfare scores, escapes), we add the missing *operational* entity so
the report consumes records, never free text. Wire format is **exactly** the Mattilsynet schema —
the regulator's schema is the contract, validated before anything leaves the process.

### Non-negotiable principles (from project rules + operator direction)

1. **Mattilsynet's format is the format.** Outbound payloads conform to the official JSON schemas;
   validation runs pre-submit and in CI contract tests. Internal models adapt to the regulator,
   never the reverse.
2. **No duplicate structures.** Where two structures overlap, the more advanced one survives and
   the other is deleted in the same phase (explicit dedup verdicts in §2/§4 below). No parallel
   "report copies" of operational data.
3. **Root-cause only.** Every problem found during this work is fixed at its root or registered as
   a tracked finding with owner + deadline. No defensive patches, no UI copy papering over a
   missing pipeline.
4. **Fail-closed.** Missing identity (org.nr, lokalitetsnummer), missing schema-required fields,
   or unverifiable sensor data block submission with a precise, actionable error.
5. **Idempotent + auditable.** `klientReferanse` discipline stays; every submission attempt,
   receipt (`referanse`) and failure is persisted; resubmission updates, never duplicates.

## 1. Verified as-is (2026-07-06, main)

Backend `apps/farm-service/src/regulatory/`:
- **Real Maskinporten JWT-bearer client** (`maskinporten.service.ts`) — per-tenant creds
  AES-256-GCM at rest, token cache, TEST/PROD envs.
- **Real Mattilsynet REST client** (`mattilsynet-api.service.ts`) — 5 endpoints (lakselus,
  rensefisk, settefisk, slakt planlagt/utført), Norwegian-schema payload interfaces.
- **3 pipelines**: REST (5 types, persist-first PENDING→SUBMITTED/FAILED);
  varsling (welfare/escape/disease → transactional outbox → notification-service email to
  `varsling.akva@mattilsynet.no` / Fiskeridirektoratet, status QUEUED);
  biomass (**local-only** `biomass_reports`, DRAFT→SUBMITTED, immutable once submitted).
- Entities: `regulatory_reports` (unique `(tenantId, reportType, klientReferanse)`),
  `biomass_reports` (unique `(tenantId, siteId, reportMonth, reportYear)`), `regulatory_settings`
  (org.nr, site→lokalitetsnummer mappings, Maskinporten creds, godkjenningsnummer).
- Frontend `web/modules/farm-module/src/pages/reports/` — 8 tabs, fail-closed identity SSoT
  (`regulatoryIdentity.ts`), stable `klientReferanse` hook, tenant-scoped localStorage drafts,
  persisted submission history + CSV export.

Data layer (all per-tenant, farm schema): `batches_v2` (speciesId, currentQuantity, weight,
stockedAt, supplier), `farm_stock_batch_snapshots`, `mortality_records` (cause enum, indexed
`(tenantId, cause)`), `tank_operations` ledger (TRANSFER_IN/OUT, MORTALITY, SAMPLING, ADJUSTMENT,
CLEANER_*), `harvest_records` (+ statistics handler), `feeding_records` (+ summary handler),
`species`, `water_quality_measurements` + `sensor_temperature_latest` (NATS-fed projection) +
`WaterTemperatureService` (sensor-else-manual, newest wins), fish-health `health_events`
(treatment/vet/lab jsonb), `chemicals` catalog, full cleaner-fish command set.

Branch audit result: **all feeding/water-temperature phase branches are already on main in
hardened form** (verified via `git cherry` + content diff; the stale branches would regress
GSEC-hardening if merged). No open branch touches regulatory/report files. Nothing to merge.

## 2. Problems found on the way — root-cause register

Every item below is either fixed in a phase of this plan (column "Fix") or explicitly tracked.
IDs continue the farm review series as `RPT-*`.

| ID | Severity | Problem | Root cause | Fix |
|---|---|---|---|---|
| RPT-001 | CRITICAL | Biomass tab claims "will be submitted to Fiskeridirektoratet" but **nothing is transmitted anywhere** | FD-0001 has no public API; the UI copy papered over the gap | Phase 5: honest channel state machine (ALTINN_MANUAL: DRAFT→READY→CONFIRMED_SUBMITTED + Altinn-ready export); UI copy fixed; no fake "submitted" |
| RPT-002 | HIGH | No server-side report assembly — prefill is client-side `useTanksList` math (feed = daily×30 guess) | Aggregation was built where the data was visible (browser), not where it lives | Phase 1: server-side `ReportAssemblyService` per report type; **delete** the client-side aggregation helpers (dedup: server assembly survives) |
| RPT-003 | HIGH | No scheduling: no period-rollover drafts, no deadline engine, no failed-submission retry | Reports were built as forms, not as a pipeline | Phase 3: period cron + deadline engine + retry queue via outbox |
| RPT-004 | HIGH | Sea lice counts have **no operational entity** — the weekly legal numbers are typed straight into the form | Missing domain: lice counting was never modeled | Phase 2: `lice_counts` entity in fish-health (per pen/week/stage + fishSampled); report consumes records |
| RPT-005 | HIGH | `sjøtemperatur` needs a weekly 3 m series; `sensor_temperature_latest` keeps **latest-only**, manual series lives in `water_quality_measurements` | Projection was built for the feed-rate use case (latest), not reporting (period series) | Phase 2: extend projection with a period-aggregate read (tenant-scoped `sensor_temperature_daily` rollup or query over sensor-service history via existing NATS-fed data); `WaterTemperatureService` gains `getPeriodTemperature(siteId, isoWeek)` — single temperature SSoT for feed-rate AND reports (no second temperature path) |
| RPT-006 | MEDIUM | `species.code` is a free internal string; reports need official FAO `artskode` (SAL, USB, BER…) | Species catalog predates regulatory use | Phase 2: `species.officialCode` column + seeded FAO/Norwegian code list + backfill migration; report mapper fails closed on unmapped species |
| RPT-007 | MEDIUM | Harvest `QualityGrade` (PREMIUM/A/B/C/REJECT) ≠ Norwegian kvalitetsklasser (superior/ordinær/produksjonsfisk/utkast) | Two taxonomies grew independently | Phase 2 dedup verdict: Norwegian classes become the **stored** taxonomy on `harvest_records` (regulator format wins); PREMIUM/A/B/C remains only as an optional display alias — no dual storage |
| RPT-008 | MEDIUM | Treatments are a jsonb blob inside `health_events`; lakselus needs typed per-application rows (virkestoff enum, mengde, badebehandling) | Treatment modeled as event metadata, not as an application record | Phase 2: `treatment_applications` entity FK→`chemicals` + batch/tank + quantities; HealthEvent keeps the clinical narrative (no duplication: application facts live ONLY in the new table; jsonb `treatment.medication` fields are migrated + dropped) |
| RPT-009 | MEDIUM | Escape has a notification form but **no operational incident entity** (nothing to reconcile against) | Missing domain | Phase 2: `escape_incidents` entity; varsling report consumes it |
| RPT-010 | MEDIUM | Welfare indicators unstructured (`symptoms` free-string arrays) | Missing structured scoring | Phase 2: `welfare_assessments` (gill/fin/wound/deformity scores) in fish-health |
| RPT-011 | MEDIUM | Vet identity is free text per health event; no personnel reference | Missing catalog link | Phase 2: reference `workers` (setup catalog) with role=VET + license field; free-text vet fields become a fallback for external vets only |
| RPT-012 | MEDIUM | `BiomassCalculatorService.getSiteBiomassReport` is fully built but **dormant** (no resolver calls it); parallel biomass math exists in snapshots + client | Wiring was never finished; three biomass computations coexist | Phase 1 dedup verdict: `BiomassCalculatorService` (species-aware, site-level) becomes THE biomass source for reports, reading `farm_stock_batch_snapshots` joined to `batches_v2.speciesId`; client-side `aggregateBiomassFromTanks` is deleted |
| RPT-013 | MEDIUM | Mortality-by-cause index exists but no GROUP BY query; internal cause taxonomy ≠ report cause lists (rensefisk's 9 uttak causes, FD-0001 losses) | Aggregation + mapping never built | Phase 1: `GetMortalityByCauseQuery`; Phase 2: explicit internal→regulatory cause mapping table (fail-closed on unmapped) |
| RPT-014 | MEDIUM | Transfers ledger is tank-to-tank; external "flyttet eksternt / counterparty" exists only as free text | External transfers were never first-class | Phase 2: `tank_operations` gains typed external-transfer fields (counterparty org.nr, destination lokalitetsnummer) |
| RPT-015 | LOW | `lokalitetsnummer` lives as a side mapping in `regulatory_settings.siteLocalityMappings` instead of on `sites` | Historic placement | Phase 2 dedup verdict: move to `sites.lokalitetsnummer` (+ org.nr override per site if needed); `regulatory_settings` keeps only company-level identity + creds; mapping jsonb is migrated then removed — one home for locality identity |
| RPT-016 | LOW | Smolt semantics missing (`BatchInputType` has no SMOLT; `karId` mapping ad hoc) | Hatchery reporting was bolted onto grow-out batch model | Phase 2: SMOLT input type + production-unit (kar/merd) external-ID on tanks |
| RPT-017 | LOW | Local endpoint paths/`Client-Id` header unverified against live swagger (proxy-blocked) | Docs unreachable from CI | Phase 0: verify from unblocked network; contract tests pinned to the verified schema. Tracked; owner: operator (needs network) |
| RPT-018 | LOW | No submission verification loop (did Mattilsynet actually register it?) | One-way fire | Phase 3 (optional): BarentsWatch public-data cross-check for lice reports |
| RPT-019 | MEDIUM | Mobile app has zero reporting/field-capture surface | Never built | Phase 6 |

## 3. Target architecture

```
           ┌────────────────────────── farm-service ──────────────────────────┐
 Operational SSoTs                 Assembly & pipeline               Regulator
 batches_v2 / snapshots ─┐   ┌─ ReportAssemblyService (per type) ─┐
 mortality_records ──────┤   │   • period aggregation (indexed)   │  Mattilsynet REST
 tank_operations ────────┤   │   • field provenance (RECORDS /    │  (Maskinporten)
 harvest_records ────────┼──►│     SENSOR / MANUAL_REQUIRED)      ├─► lakselus/settefisk/
 feeding_records ────────┤   │   • official-code mapping          │   rensefisk/slakt
 lice_counts (new) ──────┤   │   • schema validation (official)   │
 treatment_applications ─┤   └── ReportSchedulerService ──────────┤  Varsling (outbox→email)
 welfare/escape (new) ───┤        • period rollover → DRAFT       ├─► welfare/escape/disease
 WaterTemperature SSoT ──┘        • deadline engine + reminders   │
 (sensor proj + manual)           • retry queue (outbox)          │  Altinn manual channel
                                                                  └─► biomass FD-0001 export
 Setup catalogs (species/suppliers/feeds/chemicals/workers/sites+lokalitetsnr)
   └── referenced by ALL forms as dropdowns — no free text where a catalog exists
```

- **Assembly, not entry.** `reportPrefill(type, period, siteId)` GraphQL query returns the fully
  computed draft + per-field provenance. Forms render it as review-and-approve. A field whose
  provenance is `MANUAL_REQUIRED` is the only kind the operator must type.
- **Sensor-or-manual (the temperature pattern, generalized).** Provenance `SENSOR` carries
  sensorId + measuredAt; the operator sees the reading, can override with a manual measurement —
  and an override writes a `water_quality_measurements` MANUAL row (source data), never a
  report-only edit. Same pattern for any future sensor-backed field (oxygen, salinity).
- **Corrections flow to the source.** Editing an assembled number (e.g. mortality count) opens the
  underlying record flow (`tank_operations` ADJUSTMENT / mortality record correction); the report
  re-assembles. Reports never fork from operations.
- **One temperature path, one biomass path, one cause taxonomy** — dedup verdicts in §2 are
  binding: the surviving structure is named, the loser is deleted in the same phase.

## 4. Phases

Phases are independently shippable, each green (`nx affected --target=test/lint`) before merge.
Per-tenant tables omit `schema:`; migrations registered in the manifest; MODULE_SCHEMAS updated
for any new table.

### Phase 0 — Contract layer (schema truth)
- Verify live swagger from an unblocked network (RPT-017); diff `dto/regulatory-inputs.dto.ts` +
  payload interfaces field-by-field; fix any drift.
- Add pre-submit **official-schema validation** (JSON Schema per service under
  `apps/farm-service/src/regulatory/schemas/`) + CI contract tests — invalid payloads never reach
  the network (make-it-detectable → make-it-impossible at the submit boundary).
- Deliverable: `docs/integrations/mattilsynet-reporting-api.md` kept as the schema SSoT (done).

### Phase 1 — Server-side report assembly (RPT-002, RPT-012, RPT-013 aggregation)
- `ReportAssemblyService` + CQRS queries: `GetBiomassBySpeciesQuery` (wire dormant
  `BiomassCalculatorService.getSiteBiomassReport`), `GetMortalityByCauseQuery` (GROUP BY on the
  existing index), `GetTransfersSummaryQuery` (tank_operations roll-up), feed-by-type via
  `GetFeedingSummary` + feed join, stockings via `batches_v2.stockedAt/initialQuantity`,
  slaughter via harvest statistics + species join.
- GraphQL `reportPrefill(type, period, siteId)` with per-field provenance.
- Frontend: tabs consume `reportPrefill`; **delete** `aggregateBiomassFromTanks` /
  `aggregateFeedFromTanks` client math (dedup).
- Biomass tab becomes review-and-approve: species/quantity/biomass never typed.

### Phase 2 — Missing operational entities + official code mappings (RPT-004…011, 014, 015, 016, RPT-006/007 taxonomies)
- fish-health: `lice_counts`, `treatment_applications` (FK chemicals), `welfare_assessments`;
  `escape_incidents`; typed external-transfer fields; `species.officialCode` + seed;
  Norwegian kvalitetsklasser on harvest; `sites.lokalitetsnummer` migration (+ remove settings
  jsonb mapping after backfill); SMOLT input type + production-unit external IDs; vet = worker
  reference.
- `WaterTemperatureService.getPeriodTemperature` (RPT-005) — weekly/monthly aggregate, sensor +
  manual union, one SSoT for feed-rate and reports.
- Every new/changed form field binds to a setup catalog or entity — free text only where the
  regulator's schema itself is free text.

### Phase 3 — Scheduling, deadlines, retries (RPT-003, RPT-018)
- `ReportSchedulerService` (cron, per tenant/site): period rollover creates DRAFT reports with
  assembled data (weekly lakselus + slakt, monthly settefisk/rensefisk/biomass).
- Deadline engine: due/overdue states drive the existing `DeadlineIndicator` from data;
  notification-service reminders (deadline approaching, draft incomplete, submission FAILED).
- Retry: FAILED submissions re-queued with backoff through the outbox; permanent failures alert.
- Optional auto-submit per tenant+type, only when every field provenance is RECORDS/SENSOR and
  schema validation passes.
- Optional BarentsWatch cross-check job for lice submissions.

### Phase 4 — Forms as review-and-approve everywhere
- All 8 tabs render assembled drafts + provenance badges; setup-catalog dropdowns replace free
  text (species, suppliers, feeds, chemicals, workers/vets, sites); corrections write back to
  source records; server-side drafts replace localStorage as the primary draft store (localStorage
  stays only as offline crash recovery — dedup verdict: server draft is authoritative).

### Phase 5 — Biomass channel honesty + export (RPT-001)
- Channel state machine `ALTINN_MANUAL`: DRAFT → READY (validated, assembled) →
  CONFIRMED_SUBMITTED (operator confirms after filing FD-0001 in Altinn, receipt reference stored).
- Altinn-ready export (form-ordered values, per production unit) generated from the assembled
  payload; misleading UI copy removed.
- Watch item (tracked): if Fiskeridir ships a submission API, this channel swaps to REST without
  touching assembly.

### Phase 6 — Mobile (AquaMobil) (RPT-019)
- Field capture first (the mobile-native work): lice counting at the pen, mortality with cause at
  the tank, welfare scoring, escape incident — all writing the Phase-2 operational entities via
  existing offline-first queue patterns; sensor temperature shown at capture time.
- Report surface second: due/overdue list, review assembled draft, approve/submit (same GraphQL
  pipeline; no mobile-specific report logic — dedup: one submission path).

### Phase 7 — Hardening
- E2E: mock Mattilsynet server integration tests (success/validation-error/401/timeout);
  idempotency tests (double submit, retry storms); tenant-isolation audit on all new tables;
  performance: EXPLAIN on assembly queries (indexes exist for mortality cause; add
  `(tenantId, feedingDate)` / `(tenantId, harvestDate)` if plans show seq scans); observability:
  submission counters, deadline SLO alerts, Maskinporten token-failure alarms; security review of
  key handling paths.

## 5. Open decisions (need operator/product input)

1. **Maskinporten supplier model**: does each tenant register their own integration (current
   per-tenant creds model) or does Suderra act as leverandør with Altinn delegation +
   `onBehalfOf`? Current entity supports per-tenant; delegation model would move creds to
   platform level. Affects Phase 0/3 but not assembly.
2. **Auto-submit default**: opt-in per tenant+report-type recommended (regulator-facing sends
   should start human-approved).
3. **Slaughterhouse as entity**: single `godkjenningsnummer` (today) vs facility catalog —
   needed only for multi-facility tenants.

## 6. Explicitly out of scope

- Building a Fiskeridirektoratet REST submission (no public API exists — RPT-001 handles the
  channel honestly instead).
- Welfare/escape/disease API submission (no API scope exists; varsling email pipeline stays).
- Historical backfill of lice counts/treatments before the new entities exist.
