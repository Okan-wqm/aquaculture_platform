# Farm Domain Full-Integration Review

Scope: end-to-end integration audit of the farm domain — `apps/farm-service`, `web/modules/farm-module`, tenant-schema persistence, gateway federation surface. Produced by a three-lane exploration (backend structure, frontend wiring, cross-cutting integration/quality) on 2026-07-01/02. Findings below are the tracked work items for the farm full-integration effort on branch `claude/farm-module-integration-8owrtl`.

Status legend: OPEN → IN-PROGRESS → RESOLVED (merged commit carries `Closes:`).

---

## FARM-INT-HIGH-001 — Regulatory report submissions are not persisted; FE lists are mock

Seven regulatory report types (sea lice, cleaner fish, smolt, planned slaughter, executed slaughter, welfare event, escape, disease outbreak) are submitted to Mattilsynet through `apps/farm-service/src/regulatory/regulatory.resolver.ts` (+ `mattilsynet-api.service.ts`, `regulatory-varsling.service.ts`) but never persisted locally. Only biomass has an entity (`regulatory/entities/biomass-report.entity.ts`) and list query.

Validated evidence:

- `apps/farm-service/src/regulatory/regulatory.resolver.ts` — submit mutations return `ReportSubmissionResult` without writing any row.
- `web/modules/farm-module/src/pages/reports/tabs/SeaLiceReportTab.tsx:14` (and 6 sibling tabs) — historical lists render from `pages/reports/mock/*`.
- `web/modules/farm-module/src/pages/reports/ReportsPage.tsx:17,256-257` — header stats/badges from `mock/helpers`.
- `web/modules/farm-module/src/pages/reports/hooks/useDeadlines.ts:17` — deadline coverage from mock helpers.

Required remediation:

- Polymorphic per-tenant `regulatory_reports` table (entity omits `schema:`), migration in `FARM_MIGRATIONS` manifest, `MODULE_SCHEMAS['farm'].tables[]` entry (strictOwnership).
- Persist-first submit flow for the five REST report types (PENDING → SUBMITTED/FAILED); atomic row insert inside the varsling outbox transaction for the three varsling types (QUEUED).
- CQRS read side: `regulatoryReports`, `regulatoryReport`, `regulatoryReportSummary` + permission-matrix entries.
- FE tabs, summary, and deadlines wired to the real queries; `pages/reports/mock/` deleted; `MOCK_IMPORT_BASELINE` in `tests/invariants/farm-no-mock-data-growth-ssot.spec.ts` reaches empty.

Closure criteria: all report tabs render persisted rows; mock dir deleted; invariants green (`farm-graphql-fe-be-parity`, `farm-no-mock-data-growth-ssot`, `farm-service-migration-array-completeness`, `tenant-fanout-entity-parity`). Closing commits carry `Closes: docs/reviews/farm-integration/2026-07-02-farm-full-integration.md#FARM-INT-HIGH-001`.

## FARM-INT-MEDIUM-002 — Maintenance pages built but never routed

`web/modules/farm-module/src/pages/maintenance/{WorkOrdersPage,MaintenanceSchedulesPage,SparePartsPage}.tsx` + `hooks/useMaintenance.ts` are complete and contract-clean (all root fields exist in `apps/farm-service/src/maintenance/resolvers/` and in `permission-matrix.ts`), but no route in `src/Module.tsx` and no shell nav entry exposes them.

Required remediation: routes under `/sites/maintenance/*`, shell nav entry in `web/shell/src/layouts/MainLayout.tsx`, render test for the wired surface.

Closure criteria: pages reachable from nav; parity spec still green; render test present.

## FARM-INT-MEDIUM-003 — farm-module ships a fully mock SensorDashboard remote

`web/modules/farm-module/src/pages/SensorDashboardPage.tsx:22` renders hardcoded `mockSensorGroups` and is exposed via Module Federation (`vite.config.ts` `./SensorDashboard`) while the dedicated `sensor-module` remote owns live sensor monitoring.

Required remediation: delete the page, the federation exposure, the `sensors` routes in `Module.tsx`, and the `farmModule/SensorDashboard` type declaration in `web/shell/src/types/remote-modules.d.ts`.

Closure criteria: `grep farmModule/SensorDashboard` → zero hits; build green.

## FARM-INT-MEDIUM-004 — Dead backend modules in farm-service

Zero-reference code confirmed by class-name and path grep:

- `apps/farm-service/src/modules/system-optimizer/` (3 services, no `.module.ts`, never imported)
- `apps/farm-service/src/modules/tank-telemetry/` (3 services + 2 workflows, no `.module.ts`, never imported)
- `apps/farm-service/src/database/migrations/add-system-hierarchy.sql` (outside the numeric manifest glob; inert)

Required remediation: delete all three. Note `mobile-command/` is explicitly NOT in this set (see FARM-INT-INFO-010).

Closure criteria: directories gone; `nx affected` test/lint green; migration completeness spec green.

## FARM-INT-MEDIUM-005 — Dead frontend code in farm-module

- `web/modules/farm-module/src/services/tank.service.ts` — zero importers; duplicates the `equipmentList` query and a second `Tank` type.
- `web/modules/farm-module/src/pages/cleaner-fish/CleanerFishPage.tsx` — route redirects to the Tanks tab; only its own barrel references it (`components/` and `types.ts` stay — used by `TanksPage.tsx:28-32`).
- `web/modules/farm-module/src/pages/storage/mock/` — 9 files, unimported since storage moved to real GraphQL.
- 23 orphaned feeding-program operations in `src/graphql/feedingProgram.{mutations,queries}.ts`, frozen in `tests/invariants/dead-contract-fe-operations.baseline.json`.
- Duplicate `Tank` type definitions (`hooks/useTanks.ts` is the SSoT; cleaner-fish modal locals to be consolidated).

Required remediation: delete the dead files/consts, shrink the dead-contract baseline 80 → 57 in the same commit, consolidate `Tank` types via import/`Pick` from `hooks/useTanks`.

Closure criteria: baseline honesty test green at 57; type-check green; no new dead ops.

## FARM-INT-MEDIUM-006 — Grading modeled in enums but has no first-class operation

`AllocationType.GRADING`, `OperationType.GRADING`, and `BatchLocation` grading semantics exist across batch entities, but there is no `record-grading` command/handler/mutation; grading is only recordable implicitly.

Required remediation: `RecordGradingCommand` + handler (single transaction over `tank_batches`/`tank_allocations`/`tank_operations`, counts through the single-writer path), `BatchGraded` event contract, `recordGrading` mutation + DTO + permission-matrix entry, FE `GradingModal` + mutation hook. Verify the `tank_operations.type` DB enum includes `'grading'`; additive enum migration if not.

Closure criteria: handler spec green (cloned from transfer spec); parity + outbox/transaction SSoT invariants green.

## FARM-INT-MEDIUM-007 — WaterQualityCritical published with no alerting consumer

`apps/farm-service/src/water-quality/services/water-quality.service.ts:282,430` publishes `WaterQualityCritical`, but no alert-engine or notification consumer subscribes; the event only reaches browsers via the gateway NATS bridge. Critical water-quality conditions therefore never create alert incidents.

Required remediation: alert-engine handler + service (template: `apps/alert-engine/src/alert/event-handlers/mortality-alert.handler.ts`) creating escalatable incidents; check/extend `tests/invariants/required-signals-vs-emitters.spec.ts`.

Closure criteria: consumer registered + tested; invariant updated if it tracks emitter↔consumer pairs.

## FARM-INT-LOW-008 — Dead Export button on ReportsPage

`web/modules/farm-module/src/pages/reports/ReportsPage.tsx:338-346` renders an Export button with no `onClick`.

Required remediation: client-side CSV export of the active tab's real report list (pattern: `pages/water-chemistry/waterChemistryReportExport.*`), or removal where export is meaningless. A dead button may not remain.

Closure criteria: button functional (or gone) with a spec.

## FARM-INT-MEDIUM-009 — farm-module test coverage: 7 spec files for ~20 page domains

Only `utils/list-view-state`, 3× water-chemistry, and 3× reports specs exist. Production/batch, feeding, tasks, storage, harvest, health, setup, maintenance, tanks, analytics, map have zero FE tests.

Required remediation: shared test scaffolding (`src/test-utils/`) + per-domain hook and page render specs in ten ordered batches (tanks, batches+modals, feeding, maintenance, reports, storage, tasks, health/harvest, setup/company, analytics/map).

Closure criteria: each batch lands green as its own `test(farm-module)` commit; all ten batches merged.

## FARM-INT-INFO-010 — Exploration correction: mobile-command is live (no action)

Initial exploration flagged `apps/farm-service/src/mobile-command/` as dead. Verified false: `feeding.module.ts:22,87` and `harvest.module.ts:31,64` register `FarmMobileCommandReceipt` via `TypeOrmModule.forFeature`, `MobileCommandReceiptService` (from `@aquaculture/backend-common/mobile-command`) consumes it across feeding/harvest/task/batch/water-quality write paths for offline-sync idempotency, and its table is created by `1800600000000-ExtendFarmStockReadModelFanout.ts`. Recorded so future audits do not re-flag it. No action.
