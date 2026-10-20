# 2026-10-19 — Tenant-console design alignment (tanks / health / maintenance / storage)

Findings from the design-handoff reference (Tenant Console D4) vs the repo.

## FE-HIGH-371 — tanks page: design layout not implemented, quick-action toolbar at page level

- Design (search → single-row filter bar → dense unit table → click-to-open
  detail drawer) vs repo (toolbar selects + icon buttons + data table).
- Fixed: /sites/tanks rebuilt to the design layout — Üretim/Temizlikçi balık
  tabs, "Birim, parti veya yem ara…", one-row filters (sites · type ·
  stocked/empty · status), result-count line, TankTable (9 design columns
  default, 30-column model via the restored column-visibility menu), right
  TankDetailDrawer (metrics grid, density·capacity bar, live Sıcaklık/DO via
  the linked sensor, feeding block, operations incl. new Tartım örneklemesi
  wired to recordGrowthSample).

## FARM-MEDIUM-463 — health page lacks the design's withdrawal KPI and mortality chart

- Backend had no `withdrawalActive` stat and no daily-mortality aggregate.
- Fixed: `healthEventStats.withdrawalActive` (earliestHarvestDate > now) and
  new `mortalityDailyHistory(days)` query (batch domain, tenant-scoped GROUP
  BY recordDate, classified in the permission matrix); page gains status
  chips, 6-tile KPI strip, Unit column and the 14-day mortality chart.

## FE-MEDIUM-372 — feeding records table had no column selection

- Fixed: column-visibility menu (10 core + 9 opt-in detail columns), reusing
  the tanks column machinery (no duplicate mechanism).

## LOW-004 — work orders KPI strip (folded into FE-MEDIUM-372)

- Fixed: Açık / Gecikmiş / Devam eden / Tamamlanan·30g from the existing
  `workOrderStatistics` query.

## FE-HIGH-373 — tasks console dead in production (scalar selection on object lists)

> Registry row FE-HIGH-374 (IN-PROGRESS, deadline 2026-11-02) tracks this same
> tasks-console scalar-selection defect; its review_file cites this section.

- **Evidence (live, app.suderra.com):** every query/mutation embedding
  `TASK_FIELDS`/`RECURRING_TEMPLATE_FIELDS` fails with
  `Field "checklistItems" of type "[TaskChecklistItem!]!" must have a selection of subfields`
  (same for `notes`). Validation fails before execution, so the UI's
  create/save buttons never reach the server — the user sees dead buttons and
  no records. `createTask` with a valid input saves fine when called directly.
- **Fix:** subfield selections
  (`checklistItems { id text isCompleted completedAt completedBy }`,
  `notes { id text createdBy createdAt }`) in `useTasks.ts` and
  `useRecurringTemplates.ts`; the frontend `ChecklistItem`/`TaskNote` types
  already match the wire shape.

## FE-HIGH-375 — feeding protocols console dead: FE requests the non-contract `version` field

- **Evidence (live, app.suderra.com):** `feedingProtocolsV2` returns
  `Cannot query field "version" on type "FeedingProtocolV2"` — list, detail,
  create and update protocol operations all embed the same fragment, so
  /sites/feeding renders "Failed to load protocols" and the protocol/assignment
  tabs cannot load or save.
- **Root cause:** `@VersionColumn()` is a DB-layer optimistic lock
  (`feeding-protocol-v2.entity.ts:274`) with no `@Field()`, so the wire type has
  no `version`; the FE fragment (and the unused hook type member) carried it.
- **Fix:** drop `version` from `FEEDING_PROTOCOL_V2_FIELDS` and the hook type —
  backend contract unchanged, no FE consumer reads it.

## FE-HIGH-376 — health console status chips send lowercase DB values

- **Evidence (live):** `healthEvents(filter:{status: "active"})` →
  `Value "active" does not exist in "HealthEventStatus". Did you mean the enum
value "ACTIVE"?` — the PR #2026 chip row shipped `active/monitoring/resolved`
  (DB values) instead of the wire enum keys, so every chip click blanked the
  page behind "Error loading health events. Please try again."
- **Fix:** chip values to `ACTIVE/MONITORING/RESOLVED` (same wire-key rule the
  page's own label maps and FARM-CRITICAL-409 already follow).

## FE-HIGH-377 — production planning surface (Üretim Planı)

- **Gap:** tanks carry protocol assignments and realized growth, but nothing
  projected a tank's growth curve forward — grading dates (2 g, 100–120 g
  operator thresholds) and capacity overfill were invisible until they
  happened.
- **First slice (this PR):** `temperature_scenarios` + dated points (tenant
  migration 1823000000000; source manual, Copernicus later),
  `tankGrowthProjection` day-by-day simulation (protocol band by weight →
  rate × temperature multiplier → feed ÷ expected FCR → next biomass; capacity
  fill % and over-capacity day), and the Üretim Planı tab (scope site/system,
  horizon, scenario editor with the operator's interpolation rule).
- **Next phase (tracked, not here):** the grading puzzle planner — class
  distribution from sampling CV, class→tank allocation with capacity and
  harvest-timing constraints, same-size batch merge suggestions, plan→
  recordGrading bridge.
