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
