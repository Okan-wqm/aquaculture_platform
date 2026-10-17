# Tenant Console D6 — Industry shell on the tenant console (2026-10-16)

Source: the Claude Design handoff `design_handoff_tenant_console_industrial` (main reference
`Tenant Console D6 Repo.dc.html`, page map `tenant-repo.js`). The design re-skins and restructures
the tenant console; what the repo already has stays the basis. Every item the designer marked NEW
was checked by two independent searches of `web/` and `apps/` before it was built; items that
already exist elsewhere are linked from the navigation instead of rebuilt (parameter dictionary →
`/sites/water-chemistry?tab=parameters`, reading sources → `?tab=sources`, slaughter facilities →
`/sites/setup/slaughter-facilities`, device status → `edgeDeviceStats`).

Owner: claude (implementation), okan (review).

Okan's decisions (2026-10-16): absent backends get a labelled preview, rendered only through a typed
`MockPreview` path, each with a tracked finding below; `/sensor/commands` shows the real fragments
and previews the rest; per-module alarm counts in the workspace menu are a labelled preview.

## Work findings

### FE-HIGH-333

The tenant console painted the Suderra paper/teal palette with rounded cards and a serif display
face, and the token scope (`:where(.sd-page, .sd-surface)`) reached only pages that carry
`sd-page`: no farm, sensor, hydroponics or dashboard page does, nor any portaled dialog. Phase 1
re-points the `sd-*` tokens to the Industry palette (Drawing light / Control room dark), adds the
hazard, grid and workspace-accent tokens, loads Barlow / Barlow Condensed, squares the scope's
radii, draws blueprint corner marks on `.sd-card`, replaces the paper glow with the engineering
grid and noise, and widens the scope to the console column and to dialogs opened over it.

### FE-HIGH-334

The tenant shell had no workspace (module) switcher, console header, title block, command palette
or annunciator; the header search submitted to an empty handler. Phase 2 builds them.

### FE-HIGH-335

The route inventory (186 route declarations, 101 leaf pages) found 22 pages reachable by URL only
and two module-user links (`/analytics`, `/reports`) that resolve to NotFound outside the layout.
The console navigation covers every leaf page, and a nav-coverage invariant fails the build on an
unreachable route.

### FE-MEDIUM-336

HR Today, the facility structure tree and the two architecture documents had backing data (or are
static) but no UI.

### HR-HIGH-022

`LeaveRequest.startDate/endDate` and `AttendanceRecord.date` hydrated as `YYYY-MM-DD` strings that
the GraphQL `DateTime` scalar refuses, so `teamLeaveCalendar`, `leaveRequests`,
`attendanceRecords` and `todaysAttendance` failed once a row existed. Fixed with the shared
`DateColumnTransformer`; three of the 45 columns of FARM-MEDIUM-424, which stays open for the rest.

### FARM-MEDIUM-438

`DepartmentResponse.departmentManager` mapped to no column; the stored `managerUserId` /
`managerName` had no response field. The response now exposes the two columns.

### FE-MEDIUM-337

No sanctioned way existed to show preview data for a feature whose backend does not exist. The
typed preview path makes rendering preview data without its notice impossible.

## Tracked backend gaps (rendered as labelled previews)

| ID                | Missing                        | Preview surface                             |
| ----------------- | ------------------------------ | ------------------------------------------- |
| FARM-MEDIUM-439   | Budget per cost centre         | Finance › Budget                            |
| FARM-MEDIUM-440   | Cost centres, allocation keys  | Finance › Cost centres, facility cost share |
| SENSOR-MEDIUM-185 | Command log and lock model     | `/sensor/commands` unified log and locks    |
| ALERT-MEDIUM-010  | Server alarm count by module ¹ | workspace-menu module counts                |
| FE-LOW-338        | Page/sheet revision concept    | title-block revision cell                   |

Owner okan, deadline 2026-11-16 for each.

¹ The tenant-wide count by priority is served: alert-engine `activeAlertCounts` counts the
unresolved alarms per (severity, acknowledged), and the annunciator folds them onto P1/P2/P3. The
page-based count it replaced lost an older active CRITICAL behind 100 newer INFO or
resolved-but-unacknowledged rows and capped every count at 100. The count per module followed on
2026-10-17: every alarm records its module and site, `activeAlertCounts` groups by them, and the
workspace menu reads real counts with its preview deleted
(`docs/reviews/claude/2026-10-17-module-dashboards.md`).

## Tracked theme gaps (open)

### FE-MEDIUM-339

Owner okan, deadline 2026-11-16. Status OPEN. Found by the farm-module theme audit; two patterns
the console scope cannot re-map. Paths below are under `web/modules/farm-module/src/`.

1. **Charts and swatches paint from `theme.ts` `colors.*`.** Those are hex values read at import,
   so the scope's `--color-*` re-assignment never reaches them, and `colors.success[*]` is the
   legacy green README §7.8 keeps out of the console. Sites:
   `pages/analytics/tabs/TanksAnalyticsTab.tsx` (status pie: `operational` / `active` on
   `success[500]`), `pages/finance/components/ChartsTab.tsx` (`REVENUE_COLOR = success[600]`,
   `EXPENSE_COLOR = info[600]`), `pages/water-chemistry/components/ConfigFormModal.tsx` (default
   `chartColor` `info[500]`, swatch fallback `neutral[300]`), `pages/feeding/components/`
   (`FCRAnalysis`, `DepletionForecastChart`, `GrowthForecastChart`, `UnitTransitionTimeline`),
   `pages/tanks/components/TankChartsSection.tsx`,
   `pages/water-chemistry/components/{HistoryTab,ParameterConfigManager}.tsx` and
   `pages/storage/components/OverviewTab.tsx`. Root-cause fix: a shared-ui chart palette that
   resolves the `--color-*` custom properties on the chart's container at paint time (and again on
   a theme or workspace change), used in place of `colors.*`. The print exports
   (`pages/water-chemistry/waterChemistryReportExport.ts`,
   `pages/production/tabs/batchTraceabilityReportExport.ts`) render outside the console and keep
   `colors.*`.
2. **Taxonomies painted on the alarm scales.** A category (a kind of thing, not a state or a risk)
   on warning / error / accent reads as an amber or red alarm in the console, which README §7.8
   reserves for alarm and risk: `hooks/useSpecies.ts` (`CRAB` on error),
   `hooks/useParameterConfigs.ts` `getGroupColor` (`ORGANIC` on warning),
   `pages/setup/tabs/FeedsTab.tsx` (`STARTER` warning, `MEDICATED` error),
   `pages/setup/tabs/ChemicalsTab.tsx` (`ANTIBIOTIC` error, `VITAMIN` warning),
   `pages/setup/tabs/ConsumablesTab.tsx` (`ROPE`, `ELECTRICAL` warning, `PIPE_FITTING` error),
   `pages/storage/components/StorageLocationsTab.tsx` (`FEED_SILO` warning, `HAZMAT` error),
   `pages/storage/components/PurchaseOrdersTab.tsx` (`FEED` warning),
   `pages/storage/components/StockMovementsTab.tsx` and `OverviewTab.tsx` (movement `OUT` error,
   `ADJUSTMENT` warning), `pages/production/tabs/BatchTraceabilityTab.tsx` (`FEEDING` warning),
   `pages/tasks/types/task.types.ts` `CATEGORY_CONFIG` (`HEALTH_CHECK` error, `SAFETY` warning)
   and `pages/tasks/components/CalendarTab.tsx` (the same two). Each needs a per-site call before
   it moves to gray or primary: `MEDICATED`, `ANTIBIOTIC`, `HAZMAT` and `SAFETY` may be genuine
   hazard markings.
3. **The same two patterns in dashboard and hydroponics-module** (found by their audit, same date;
   messaging-module has none). Paths are under `web/modules/`. Item 1 also covers
   `dashboard/src/widgets/WaterQualityGauge.tsx` (the `CircularGauge` stroke paints `OPTIMAL` in
   the legacy green `success[500]`; it is a plain SVG, so a `stroke-*` scale class reaches the scope
   without the chart palette), `dashboard/src/widgets/ProductionChart.tsx`,
   `dashboard/src/components/OverviewWidgets.tsx`, `dashboard/src/pages/AnalyticsPage.tsx`
   (`chartPalette`, `secondary[600]`, `accent[500]`) and the PID simulator's
   `hydroponics-module/src/pages/pid-simulator/components/{TimeSeriesCharts,SimDeffeyesChart}.tsx`
   and `engine/{deffeyes-calc,reagents}.ts` (the pH ramp and the reagent vectors are domain colours
   aliased onto the semantic scales). The simulator's nutrient pump bar, usage row, `EC +0.3`
   disturbance and `EC` controller state already paint from primary; when the chart palette lands,
   the `nut` and `EC` lines of `TimeSeriesCharts.tsx` move to primary with them (they draw the
   legacy amber today). Item 2 also covers the simulator's acid reagent on error (pump bar, usage
   row, `pH -0.5 ALK` disturbance) and the `EC WAIT` / `CHEM DT` controller hold states on warning
   (`StateIndicator.tsx`): dosing and waiting are normal operation, though acid may be a genuine
   corrosive-hazard marking.
4. **hr-module** (found by its audit, same date). Item 1 also covers
   `hr-module/src/pages/finance/components/HrChartsTab.tsx`: `PAYROLL_COLOR = colors.primary[600]`
   is the legacy blue, and `EXPENSE_COLOR = colors.warning[600]` paints a non-risk series in the
   legacy amber. The weekly schedule print (`components/scheduling/PrintScheduleButton.tsx`) writes
   its own window outside the console and keeps `colors.*`, like the farm print exports. Item 2
   had three hr sites, all fixed by the audit: the On Leave counts on the HR dashboard, Attendance
   and HR analytics and the dashboard's Leave Management tile now paint neutral;
   `pages/__tests__/leaveTone.spec.tsx` pins them.

### FE-MEDIUM-340

Owner okan, deadline 2026-11-16. Status OPEN. Found by the review of the tenant-admin theme audit.
README §7.7 draws a card as a line (square, hairline, corner marks, no fill); suderra.css `.sd-card`
owns that frame. A card written as `bg-white … rounded-* border` paints a cream-filled box with no
corner marks inside the console scope, so a page that mixes it with `sd-card` shows two looks.
tenant-admin is moved onto `SD_CARD` and held there by the hand-drawn-card rule of
`tests/invariants/web-console-theme-fit.spec.ts` (`CARD_FRAME_AUDITED`). Still filled:

1. **shared-ui `Card`** (`web/shared-ui/src/components/Card/Card.tsx`) is itself the filled box
   (`bg-white rounded-lg border shadow-sm`). The shell's settings pages draw their cards through
   it, so `ConsentSettingsPage.tsx`'s four hand-written cards stay filled with them until `Card`
   draws the blueprint frame inside the console scope (one rule for every consumer); moving
   those four alone would mix the two looks on one page. dashboard draws its cards through
   `Card` too.
2. **Hand-written cards** (2026-10-16, counted as the rule reads them): sensor-module 147,
   farm-module 130, hr-module 63, hydroponics-module 26.

Each package joins `CARD_FRAME_AUDITED` once its cards are `sd-card`.

### FE-MEDIUM-341

Owner okan, deadline 2026-11-16. Status OPEN. Found by the hr-module theme audit. A colour the
tenant picks is stored as a hex `colorCode` and painted as an inline style, so no theme, workspace
or console token reaches it: inside the console a shift, a department or a leave type keeps
whatever hue was picked, a red or amber one reads as an alarm (README §7.8), and nothing holds it to
contrast in the dark theme. Sites, under `web/modules/hr-module/src/`:
`components/scheduling/ShiftPalette.tsx:148,152` and `components/scheduling/ShiftCell.tsx:287,295`
(shift), `pages/scheduling/WeeklySchedulePage.tsx:247,697` (shift, fallback `colors.info[500]`),
`pages/scheduling/SchedulingSettingsPage.tsx:416` (the preset picker the tenant chooses from) and
`:471,477` (shift, fallbacks `colors.neutral[400]` / `[700]`), `pages/DepartmentsPage.tsx:244-249`
and `pages/HRAnalyticsPage.tsx:178` (department, fallback `colors.primary[500]`),
`components/leave/LeaveBalanceWidget.tsx:214,216` and `pages/leaves/LeavesPage.tsx:129` (leave
type). Root-cause fix: the tenant picks a slot of the console's categorical series palette (the
FE-MEDIUM-339 chart palette) instead of a hex; hr-service stores the slot key, a migration maps each
stored hex to its nearest slot, and the UI resolves the slot per theme and workspace.

### FE-MEDIUM-342

Owner okan, deadline 2026-11-16. Status OPEN. Seen by the hr-module theme audit outside its
package; shared-ui primitives and the shell paint these on every tenant page, hr's included.

1. `web/shared-ui/src/components/Avatar/Avatar.tsx` `bgPalette` gives a name-hashed initials
   avatar `accent-600`, `warning-600` or `error-600` (the hazard amber and red inside the console)
   or the unscoped legacy `neutral-600` / `secondary-600`: a person reads as an alarm.
2. `web/shell/src/components/NotificationPanel.tsx` `getNotificationIndicator` paints the leave /
   hr and billing categories on `accent-500` and tasks on `warning-500`, the farm category on
   `success-500`.
3. Pills: `Severity.tsx` (`rounded-full` with `px-*` sizes), `KpiCard.tsx:92` (trend chip) and the
   badge in `Alert.tsx:258`, where Industry tags are square.

`Header.tsx` / `Sidebar.tsx` `admin` accents belong to the platform admin console, which renders
outside the tenant console scope, and the shell `SettingsPage.tsx` avatar paints from the Industry
`sd-accent` ramp; neither is a gap. Closes when shared-ui `components/` and the shell header join
`AUDITED` in `tests/invariants/web-console-theme-fit.spec.ts`.
