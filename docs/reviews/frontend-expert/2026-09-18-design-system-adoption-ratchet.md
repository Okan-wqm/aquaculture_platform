# Design-system adoption ratchet — 2026-09-18

**Agent:** `frontend-expert` · **Mode:** WRITER (survey + gates + first
migration wave) · **Lane:** web
**Cycle:** `2026-09-18-design-need-map` · **Verdict:** CONDITIONAL
**Findings:** 4 (HIGH 3 · MEDIUM 1)

> Finding IDs are allocated above the `FE` high-water mark in
> `docs/reviews/_registry/findings.jsonl` (FE was at 064 at cycle time);
> registered with `findings:add` in the same change that lands this document.

## Scope

Textual survey of `web/` on `main @ 1e6e99f7` (1.077 `.tsx`, tests and generated
code excluded): design-system adoption per package, overlay/dialog construction,
colour and inline-style discipline, browser dialogs, i18n reach. Companion
design canvas: _Tasarım İhtiyaç Haritası_ (Design artifact, 7 boards).

## Executive summary

`web/shared-ui` is a real design system — 61 colour tokens in `theme.css`,
Modal / ConfirmModal / typed-confirmation delete dialog, Button, form fields, DataTable,
Charts — that the product mostly does not use. The brand palette
(`bg|text|border-primary-*`) appears 17 times across the 8 federated remotes
against 24.070 raw Tailwind defaults; 96 files build their own `fixed inset-0`
overlay (55 without an accessible close label, 111 stacked on one `z-50`);
2.136 raw hex colours sit outside `theme.css`; 683 inline `style={{}}` blocks
bypass tokens; 87 call sites used the browser's `confirm()` / `alert()` /
`prompt()`; 365 loading spinners were drawn by hand beside `Spinner`; 130
page title rows were written by hand with no `PageHeader` to write them with;
2.600 light surfaces had no dark counterpart while two dark-mode mechanisms
(the shell's `data-theme` override, the OS-keyed `dark:` variant) disagreed.

The first wave closed the browser-dialog class outright (ESLint `no-alert`
error, `useConfirm`/`usePrompt` + `ConfirmProvider`, Drawer, AquaMobil update
banner — commit `aae401bc`). The remaining three classes cannot be closed in one
change and are pinned by a governed ratchet so they can only shrink.

## Findings (by severity)

### HIGH

#### FE-HIGH-065 — Hand-rolled overlays duplicate Modal without its behaviour

96 files outside `shared-ui` carry a `fixed inset-0` overlay. 27 `role="dialog"`
occurrences in total; 55 close buttons have no `aria-label`; only two files trap
focus (shared-ui's Modal and tenant-admin's private `useFocusTrap`, a second
implementation of the same thing). All 111 overlays sit on `z-50`, so a dialog
opened from a wizard has no defined stacking.

**Root cause:** the shared Modal existed but (a) accepted only a string title,
so every dialog with an icon in its header rolled its own, (b) had no Drawer
sibling, so every side panel rolled its own, (c) nothing detected a new overlay.

**Fix (this cycle):** `Modal`/`Drawer` accept `ReactNode` title/description and a
`bodyClassName`; `useDialogBehavior` is the single Escape/focus/scroll-lock
implementation for both; 17 dialogs migrated (12 sensor-module, 5 tenant-admin)
and tenant-admin's private `useFocusTrap` deleted. Batch 2 (same cycle):
the super-admin panel — 31 dialogs in 21 files onto `Modal`, and the mobile
navigation onto `Drawer side="left"`, deleting the third private focus-trap
implementation with it; overlays 80 → 59. Batch 3 (same cycle): tenant-admin
(10 files, 14 dialogs — its private `DeleteConfirmModal` is deleted in favour
of the shared `ConfirmModal`, which gains a `warning` slot for inline retry
errors), hr-module (4) and the farm storage dropdown, whose invisible
click-away layer is replaced by the new shared `useClickOutside` hook; the
fourth private focus trap (hr `CopyWeekModal`) goes with it; overlays
59 → 44. The hr dialogs carried `dark:` classes that follow the OS colour
scheme rather than the shell's `data-theme`; they now render on the
design-system surface, and dark-mode reach stays a Wave 2 item of the design
map. Batch 4a (same cycle): the ten sensor-module menus that dismissed
themselves through an invisible full-screen layer (builder toolbar, tab bar,
scene tree, edge toolbar, operator header, dashboard, devices, PLC pages,
unified editor) use `useClickOutside`; two private mousedown effects go with
them; overlays 44 → 39. Batch 4b (same cycle): the remaining sensor-module
dialogs (sensor picker, edge/sensor/VFD wizards, VFD rule form, FUXA widget
browser, alert-rule/escalation/PLC/tag/LoRa/I-O/firmware confirmations and
forms, properties-panel and save-layout dialogs) use `Modal`/`ConfirmModal`;
the VFD change-set detail and the shell AI assistant use `Drawer`; five
private Escape listeners, three backdrop handlers and one focus trap go with
them; overlays 39 → 19. The unified editor's full-screen dark ST editor is
registered as a runtime surface (needs a Modal theme variant). Batch 5
(same cycle, AquaMobil): the app cannot import shared-ui (standalone
lockfile, offline-first) and Konsta's Sheet/Dialog are class maps with no
dialog semantics, so it gets one local `BottomSheet` primitive (auto/tall/
full sizes, portal, `useDialogBehavior`: Escape, focus in/trap/restore,
scroll lock, inert-while-busy) and a `ConfirmSheet` on top of it. Both
hand-rolled `ConfirmDialog` copies (messaging + AccountPage) are deleted;
the attachment picker, add-member sheet, forward picker and the message
long-press menu are sheets; the new-chat "creating" veil is a live-region
status with the list inert; overlays 19 → 12. Batch 6 (same cycle): the
four runtime entries marked "re-evaluate" are re-evaluated: the SCADA
setpoint PIN keypad is a `Modal size=sm`, the PID faceplate a right
`Drawer`, the operator alarm tray a bottom `Drawer` (headerless — the
panel keeps its own header, so `Drawer` gained `ariaLabel` for the
accessible name) and the GDPR consent gate a `Modal` with no dismissal
path (no close control, Escape or overlay click); overlays 12 → 8. Batch 26
(same cycle): `Modal` and `Drawer` take `theme="dark"`, which pins
`data-theme="dark"` on the dialog root (FE-MEDIUM-072), so the ST
editor's export and import dialogs and the PLC editor's floating ST
editor (a `size="2xl"` modal that does not close on an overlay click)
are `Modal`s; `useDialogBehavior` keeps a stack of open dialogs, so a
dialog opened from inside another closes alone on Escape, and the body
scroll lock lifts with the last one; `Modal` labels each instance with
`useId` and takes a `closeLabel`; overlays 8 → 5. What remains is
genuinely not a dialog (kiosk, view overlay, camera viewfinder, media
viewers). Remaining
files are listed
per-file in `.claude/allowlists/web-design-system-ratchet.yaml` with batch
(dialog/drawer/mobile/runtime), owner, expiry and reason; the ceiling only
decreases. **Owner:** okan · **Expiry:** 2027-03-31 (runtime surfaces 2027-06-30).

#### FE-HIGH-066 — Raw hex colours outside theme.css

2.136 `#rrggbb` occurrences in 244 files; sensor-module alone 1.625 in 196 files,
all Tailwind defaults or raw RGB (`#ef4444` ×121, `#3b82f6` ×104, `#ff0000` ×28,
`#00ff00` ×19 for SCADA alarm states). The brand's Ocean Blue `#0073e6` does not
appear in the module at all.

**Root cause:** no gate; chart/gauge/SVG code was written against Tailwind's
default palette before `theme.css` existed and was never re-pointed.

**Fix (this cycle):** per-package occurrence ceilings pinned to the exact live
count (the spec rejects slack). Batch 7 (same cycle): `theme.ts` — exported
from shared-ui as `colors` — carried a _second_ palette (an Ant-Design blue as
"brand", another grey scale) that nothing consumed while every chart wrote
raw hex; it now mirrors theme.css token for token, with `chartPalette` and
`chartChrome` (grid/axis/border) on top, and
`tests/invariants/web-theme-token-parity.spec.ts` fails the build when the
two drift. dashboard (38 → 0), admin-panel (13 → 0), tenant-admin (15 → 0:
role presets and the default role colour are tokens) and the shell's QR code
and auth spinner (9 → 5; the login artwork's deep-sea gradient stays) read
`colors` instead of hex. Batch 8 (same cycle): farm-module (128 → 0), hr-module
(80 → 0) and hydroponics-module (54 → 10) read `colors`/`chartChrome` for
every chart series, status colour, shift/department preset, print stylesheet
and report export; Tailwind defaults map to the nearest theme role (blue →
info, green/emerald → success, amber/yellow → warning, red/rose → error,
violet/indigo/cyan → primary shades, pink/orange → accent shades, grey →
neutral). The ten that remain are the pH scale in
`pid-simulator/engine/deffeyes-calc.ts` — a scientific colour scale, not a
brand colour, kept as data. Batch 9 (same cycle): sensor-module (1 625 → 0,
196 files). 217 distinct values: 63 mapped by hand (Tailwind defaults and
the SCADA alarm reds/greens), the rest by nearest theme token within a
small RGB distance, all reviewed; border strings become template literals
over the token; the SCADA engine's own light/dark `ThemeTokens` derive
from `colors` too, so the operator console's dark mode is the brand
palette rather than a third one. Batch 23 (same cycle): the last 19 → 0.
The pH scale reads the theme as a diverging scale (error reds for acid
bands, warning ambers on the way to neutral, success greens at neutral,
info and primary blues for alkaline — a step apart per band, which is all
a labelled isoline needs). AquaMobil's browser-chrome colours are recorded
once, on the `theme-color` meta tag in `index.html`, where both the
pre-paint script and `useDarkMode` read them; the leave-type dot falls
back to an ocean class through `LeaveTypeSwatch` when a type carries no
colour; the Konsta surface note names tokens, not hex. Every package holds
at zero. **Closed** — raw hex at zero in every web package since batch 23
(PR #1592); the `rawHex` ratchet keeps it there. **Owner:** okan ·
**Expiry:** 2027-03-31.

#### FE-HIGH-068 — Browser confirm()/alert()/prompt() used for product dialogs

87 call sites across admin-panel (9), farm-module (55), sensor-module (18),
hr-module (1) and AquaMobil (1) opened the browser's native dialogs — unstylable,
dark-mode-blind, tab-blocking and invisible to the accessibility tree.

**Root cause:** the shared ConfirmModal required hoisting dialog state into every
caller, so the one-line `if (!confirm('…')) return;` shape kept winning; nothing
detected a new call.

**Fix (commit `aae401bc`, resolved):** ESLint `no-alert: error` for `web/**`
(zero violations from the first commit); promise-based `useConfirm()` /
`usePrompt()` backed by `ConfirmProvider` (one dialog surface mounted in the
shell, the ToastProvider pattern; throws without a provider instead of hanging);
`alert()` messages through `useToast()`; AquaMobil's service-worker
"new version" confirm replaced by the `UpdatePrompt` banner. **Owner:** okan.

### MEDIUM

#### FE-MEDIUM-067 — Inline `style={{}}` bypasses the token system

683 occurrences (sensor-module 531). Legitimate for canvas geometry and gauges;
not for colours, spacing and typography. Same ratchet shape as FE-HIGH-066.

**Refined (batch 10, same cycle):** the ratchet counts only _static_ blocks —
every value a string or number literal, so the block could have been a
utility class or a token. A runtime value reaching the DOM (a progress bar's
width, a record's colour, a virtualiser's offset) is data, not a token
bypass; 528 of the 683 were that. Of the 153 static blocks, the 20 outside
sensor-module are utility classes now (the login artwork's night-ocean
gradient moved from the component into `index.css`, which also takes the
shell's raw hex to 0); the 133 that remain are SCADA symbol geometry
(absolute positions and sizes inside process-node drawings), pinned as
sensor-module's ceiling until the symbol layer draws with SVG attributes.
**Owner:** okan · **Expiry:** 2027-06-30.

#### FE-HIGH-069 — Hand-rolled `<table>` re-implements DataTable

152 `<table>` elements across the web tree (farm 59, sensor 37, admin-panel 28,
hydroponics 10, tenant-admin 9, hr 8 — plus hr's private `DataTable` copy with
a narrower API behind seven pages — shell 1). shared-ui's `DataTable` owns
header semantics, sorting, selection, pagination, empty and loading states and
export; the super-admin panel used it on zero pages.

**Root cause:** the panel's pages predate `DataTable`; nothing detected a new
raw table, and `DataTable` rendered an empty toolbar strip when a page kept its
own filters above it, which made it look wrong to adopt.

**Fix (this cycle):** the ratchet gains a per-package `rawTable` ceiling (same
shape as raw hex). `DataTable` renders its toolbar only when it has content
and accepts readonly row arrays. Batch 11: 25 of the super-admin panel's 28
tables render through `DataTable` (28 → 3) — invoices, payments, custom plans
(its pagination replaces a private one), discount codes, subscriptions,
feature toggles, the activity log (its private expand-row state becomes
`expandable`/`renderExpandedRow`), report previews, job queues, audit trail
and retention policies, compliance requests, threat intelligence, service
health, messaging tenants/retention/audit/compliance, database schemas,
migrations, storage and slow queries, and AI personas (whose `Scope` header
had no cell behind it). The three that remain are the database explorer and
query-editor result grids (dynamic, sortable-by-server columns with key and
sensitivity markers in their headers — they need `DataTable` header slots)
and a static actuation-policy reference. Batch 12: the tenant-admin panel
follows (9 → 1) — the user list (its select-all header cell and per-row
checkboxes become `DataTable` selection, so the page's own toggle helpers go),
the audit log, invoices and payments, the database table list per module,
mobile feature flags and mobile users, and the table-schema dialog's columns
and indexes. `DataTable`'s `emptyMessage` now takes a node, so the user list's
heading-plus-hint empty state renders inside the table instead of as a second
empty state underneath it; a `DataTable` spec pins the toolbar-only-when-
needed and empty-body behaviours the pages used to hand-roll around. The one
that remains is the table-data dialog (server-described columns; needs the
same header slots as the explorer grids). Batch 13: hr-module's private
`DataTable` copy (a narrower API: `accessor` columns, a `Set` selection, an
`onSort` that its seven pages never wired, so the sort icons only flipped)
is deleted and employees, certifications, payroll, crew assignments,
rotations, leaves and attendance render through the shared one; the
rotations page pages its flat arrays client-side, so its pagination bar now
moves the rows and not only the label. The finance tabs follow: salaries,
the personnel table and HR expenses through `DataTable` (which gains a
`summaryRow` totals slot so the salary and headcount totals stay in the
table), the labour-cost ledger as a definition list (label/value lines, no
header — never a grid). `DataTable`'s rows-per-page select renders only
when a page can act on it; before, every paginated page showed an inert
one. hr 8 → 3: the weekly schedule and team overview are calendar grids and
the print schedule is a print document. Batch 14: sensor-module (37 → 15)
— the PLC connection and feeding-parameter lists, process and SCADA package
lists, automation programs (its row component folds into columns), edge
devices (its select-all header cell and row checkboxes become `DataTable`
selection), the edge device I/O channel table, LoRa devices, the channel
manager, the tag registry (its loading/error/empty rows become `loading`,
an error banner and a node `emptyMessage`), readings, VFD change sets
(list, detail, create dialog) and the VFD audit log, the automation
editor's I/O bindings and deployment history, the CSV export preview, the
dashboard table widget, the PID faceplate's connection points and recipe
values; the faceplate's property ledger is a definition list. The 15 that
stay are the SCADA runtime grids (`RuntimeTable` ×3, `DataTableRenderer`,
the heatmap), the dark operator alarm and simulation panels, the
calibration and threshold pages (their row components hold per-row edit
state, which has to move up to the page first), the automation editor's
variable table (same), the translations matrix and CSV import mapping
(language / column-keyed dynamic columns), tag watch, variable sync and the
grouped auto-detect results. Batch 15: farm-module (59 → 33) — cleaner-fish
batches, environment values, FCR analysis, the feeding summary's feed-type
breakdown (its currency threads into the columns), growth-forecast feed
requirements, harvest plans, a batch's feed assignments, batch input,
growth measurements, the cleaner-fish and sea-lice report cage rows, feeder
calibration, sub-equipment, chemicals, consumables, departments, equipment,
a feed's feeding curve, fish-health chemicals, slaughter facilities,
workers, purchase-order lines, delivery receipts, on-demand steps and
recent water-chemistry entries. Rows that had no identity of their own
(form arrays keyed by position) needed `DataTable`'s `keyExtractor` to see
the row index, which it now does. Batch 16: hydroponics (10 → 2) and the rest
of farm-module's fixed-column lists (33 → 23, three of them HTML strings in
report exports) — the dynamic tank table,
nutrient profiles, the current-formula, drainage-composition and
previous-drainage parameter grids, the result tab's macro and micro
nutrient grids (one column set reads the calculation for both), user-option
targets; feeding assignments and protocols, health events, maintenance
schedules, spare parts, work orders, feeding records, inventory-count
lines, parameter configs and the finance overview's category tables (a
column factory takes the currency). What stays raw now has a structural
reason: dynamic column sets (the water-chemistry history and translation
matrices, the feeding-record and CSV column pickers), rows that span
several `<tr>` (protocol bands), matrix editors (feeding matrix, meal
board), row components with their own state (calibration, thresholds,
water analysis, alarm and simulation panels), the storage and task tabs'
row components, and the SCADA runtime grids. Batch 17: `DataTable`
gains a `headerRender` slot (the header cell's node; `header` stays the
name the export, visibility menu and sort control use), and the
server-described grids follow — the database explorer (key and sensitivity
markers in the header, masked cells, server-side sort through `onSort`),
the query-editor results and the tenant table-data dialog (index keys); the
consent-history and equipment-mapping row components fold into columns,
as do the inventory-count, purchase-order, stock-movement, completed-task
and recurring-task lists. admin-panel 3 → 1 (the static actuation-policy
reference), tenant-admin 1 → 0, shell 1 → 0, farm 23 → 17. Batch 18: the
rows that owned their own edit state — calibration channels and alert
thresholds — keep one draft per group instead (one row edits at a time, the
draft lives beside the list), so their row components fold into columns;
the task list's checkboxes become `DataTable` selection, the generic stock
tab's column config becomes columns, the storage drill-down follows.
sensor 15 → 13, farm 17 → 14. Batch 19: the
water-analysis parameter rows (their row component goes), the finance
category and ledger tabs (header arrays), the actuation-policy reference
(a `DataTable` over a const) and the stock-solution fertilizer list (its
tank `rowSpan` becomes a badge on each group's first row). admin-panel
1 → 0, hydroponics 2 → 0, farm 14 → 12. Batch 20: the grids
whose columns come from data — the tanks page (its column pickers), the
water-chemistry history (parameter configs), the SCADA translations
matrix (one column per language), the CSV import preview (its header
row) — plus the tag watch (its mixed-type comparator stays behind
`onSort`), the variable sync comparison, the auto-detect results (one
`DataTable` per source group under a collapsible header) and the
automation editor's variable list, and the batch traceability ledgers
(their header-cell component spelled out). sensor 13 → 7, farm 12 → 7.
Batch 21: `DataTable` expansion can be controlled (`expandedRowIds`,
`onExpandedChange`, and `expandToggle={false}` when a cell of the page is
the toggle), so the protocol bands — a row plus its meal-schedule editor
under it — and the meal board (one list per day plan, its columns a
factory over the plan) render through it. farm 7 → 5. Batch 26:
`DataTable` pairs every class it paints with a dark counterpart and
takes `flush` (no card chrome, for a table that fills a panel), so the
operator alarm tray (severity tints the row, status and severity are
pills, the ACK column only on the active tab, sticky header inside the
tray's own scroll) and the ST simulation watch tables (the value column
a control for inputs, a display otherwise) render through it; its
private loading arc is the shared `Spinner`. sensor 7 → 5: the SCADA
runtime grid widgets, whose columns and colours are widget
configuration, and the heat-map grid. **Owner:** okan ·
**Expiry:** 2027-06-30.

#### FE-MEDIUM-070 — Hand-rolled loading spinners beside `Spinner`

365 loading spinners were written by hand (sensor 155, aquamobil 49,
tenant-admin 47, farm 44, admin-panel 39, hr 17, shell 6, messaging 2)
against 16 files using shared-ui's `Spinner`: a lucide `Loader2` spun by
`animate-spin` (232), a bordered ring `div`/`span` spun the same way (119, in
25 size-and-colour variants) and an inline `<svg>` arc (16). Three shapes,
five hues and no accessible name, decided page by page.

**Root cause:** `Spinner` could not sit inside a coloured button (its colours
were `primary`/`white`/`gray`, never the surrounding text), could not centre
itself as a block, and had no screen-reader name — so every button and every
loading block drew its own.

**Fix (this cycle):** `Spinner` gains `color="inherit"` (the surrounding text
colour, what a spun icon in a button had), `block` (a centred row, what
`mx-auto` on a ring meant) and `label` (a screen-reader-only name); its
`primary` is the theme's `primary-500`, not Tailwind's blue. AquaMobil, which
cannot import shared-ui, gets the same component under `components/ui/`
(ocean primary). Batch 22: every hand-rolled spinner renders through it,
365 → 0, and the ratchet gains a per-package `rawSpinner` ceiling: a lucide
loader icon or an inline `<svg>` spun by a literal `animate-spin`, or a
bordered ring spun the same way. An icon whose spin is conditional (a refresh
arrow while refetching) is an affordance, not a loading indicator, and is not
counted. **Closed** — hand-rolled spinners at zero in every web package
since batch 22 (PR #1591); the `rawSpinner` ratchet keeps it there.
**Owner:** okan · **Expiry:** 2027-06-30.

#### FE-MEDIUM-071 — Page title rows hand-written beside no `PageHeader`

130 pages opened with a title row written by hand (admin-panel 44, sensor 27,
hr 20, farm 17, tenant-admin 14, shell 4, hydroponics 3, dashboard 2,
messaging 1): a `justify-between` row in three layouts (fixed, responsive
under `sm`, responsive under `md`), an `h1` in twelve class spellings (some
with dark variants, some `text-xl`, one `sm:text-3xl`), a description in five
sizes, and the back link, icon box or badges placed differently each time.
shared-ui had `Header` and `Sidebar` for the app chrome and nothing for the
page.

**Root cause:** no primitive; each page copied the nearest page's markup.

**Fix (this cycle):** shared-ui gains `PageHeader` — one `h1`, one
description, `actions` beside the title, an `eyebrow` above it (a back
link, a category label), a `leading` element beside it (an icon box, a back
button) and children beneath (tabs, a filter strip) — responsive by default
and dark-aware. Batch 24: 119 title rows render through it (the converter
took the canonical shapes, the back-link, icon-box, badge-row, eyebrow and
band-header variants followed by structure), and the ratchet gains a
per-package `rawPageTitle` ceiling: an `h1` in `text-2xl`/`text-xl` bold or
semibold outside shared-ui. What remains is not a page header: the SCADA
view, widget dashboard and water-chemistry monitor toolbars and the pH
simulator strip (the title is one control in a dense tool strip, compact by
design), the 404 page and the HR module's load-failure state. Batch 25:
AquaMobil, which cannot import shared-ui, gets its own `PageHeader` under
`components/ui/` — the feature-toned gradient band (`tone`), the back arrow
(history pop, a handler, or none), the 22px icon, title and subtitle,
`actions` on the row, `children` inside the band, and a `hub` variant with
the glass icon box and the curved edge, which replaces the hub-only
`HubHeader`. 35 of its 39 bands render through it (the converter took the
bar and hub shapes; the record pages' theme and the stock-movement config
name a `tone` instead of a gradient class); the four that stay are the home
and account heroes, the channel list whose title row swaps into a search
field, and the error boundary. The ratchet counts `text-lg` titles too, so
the mobile band sits under the same ceiling.
**Owner:** okan · **Expiry:** 2027-06-30.

#### FE-MEDIUM-072 — Dark mode: two mechanisms, no dark-aware primitives

The shell has a theme toggle (light / dark / system, resolved onto
`<html data-theme>` by `web/shell/src/utils/theme.ts`) and implements dark
mode as a global `!important` override of thirteen light utility classes and
every input (`web/shell/src/styles/index.css`). hr-module (884) and
sensor-module (120) carry `dark:` classes keyed, by Tailwind's default, on
`prefers-color-scheme` — the OS, not the toggle — so a user who chose "light"
still saw those pages go dark with the OS. shared-ui's primitives carried no
dark variant at all, so the SCADA editor's always-dark dialogs could not be
`Modal`s and the operator's dark panels could not hold a `DataTable`. 2.600
class strings across web paint `bg-white`, `bg-gray-50` or `bg-gray-100`
with no dark counterpart (sensor 948, farm 716, admin-panel 376,
tenant-admin 224, hr 86, shared-ui 82, aquamobil 61, hydroponics 51,
shell 39, dashboard 10, messaging 7).

**Root cause:** no single definition of what `dark:` means; the override
block made light-only markup look dark enough to never be fixed.

**Fix (this cycle, batch 26):** `theme.css` defines the `dark` variant once,
on `[data-theme='dark']` — the shell's toggle, or a surface that pins the
attribute on its own root — and nowhere else; every CSS entry imports it, so
it means the same thing in every remote, and the OS reaches it only through
the toggle's "system" setting. `Modal` and `Drawer` take `theme="dark"`;
`DataTable`, `Modal` (with `ConfirmModal`) and `Drawer` pair every gray or
white class with a dark one, pinned by the strict form of the ratchet. The
ratchet gains a per-package `darkSurface` ceiling (light-only surfaces,
shared-ui included) so the count only shrinks; the shell's override block is
deleted when it reaches zero. Batch 27: a converter pairs every light gray
or white class in a file's class strings (quoted, template and `${}`
expressions, comments skipped) with the dark counterpart the override
palette implies in Tailwind grays (surface → gray-900, muted → gray-800,
borders → gray-700/600, text → gray-100…400, hover and disabled variants
alike), so a paired file looks as it did under the override; shell,
dashboard, messaging, hydroponics and hr are paired (1 037 classes in 78
files; darkSurface 2 593 → 2 400). Form controls get a base-layer dark
default in `theme.css` (`:where()` under `[data-theme='dark']`, so any
utility overrides it), which replaces the shell's `!important` input
rules; the remaining class override rules take `:not([class*='dark:…'])`
guards, so paired markup renders its own variants at once and the block
is dead code the day the ratchet reaches zero; the shell's component
classes (`.card`, `.data-table`, `.form-label`, …) are paired in their
`@apply`. Batch 28: tenant-admin and admin-panel (3 236 classes in 90
files; the converter learned to step over regex literals inside template
expressions); darkSurface 2 400 → 1 800. Batch 29: farm-module (4 748
classes in 155 files); darkSurface 1 800 → 1 084. Batch 30: sensor-module
(5 315 classes in 242 files); darkSurface 1 084 → 136. Batch 31: shared-ui
(331 classes in 34 files) and AquaMobil (282 in 53, with the app's own
convention — page surface gray-950, headline white, hairlines gray-800);
darkSurface 136 → 0 in every package, the ratchet holds it there, and the
shell's override block and the six palette variables only it read are
deleted: the page keeps `--color-bg` and `--color-text`, and everything on
it says what it looks like in the dark with its own classes. The one
`!important` left under `data-theme` pins the login card's glass fields
light on purpose. **Owner:** okan · **Expiry:** 2027-06-30.

## Enforcement

`tests/invariants/web-design-system-ratchet.spec.ts` (layer-1 shard) +
`.claude/allowlists/web-design-system-ratchet.yaml`. `no-alert: error` for
`web/**` in `eslint.config.mjs` (override 8d).

## Out of this cycle (tracked above, not done)

- Remaining overlay entries (5 runtime surfaces; see allowlist entries).
- Static inline style in SCADA symbol geometry (133).
- Raw `<table>` → `DataTable`: 13 remain after batch 26 (hr 3, sensor 5,
  farm 5): the SCADA runtime grid widgets and heat map (widget
  configuration drives columns and colours), the two feeding matrix editors (editable
  header cells, add/remove rows and columns — a spreadsheet, not a list),
  three report-export HTML strings, two calendar grids and a print document.
- Wave 2/3 of the design map (messaging to web, admin DataTable, dashboard,
  single palette across web + AquaMobil, i18n reach) — design
  work with product decisions attached; not gated here.
