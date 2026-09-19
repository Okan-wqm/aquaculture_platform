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
`prompt()`.

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
path (no close control, Escape or overlay click); overlays 12 → 8. What
remains is genuinely not a dialog (kiosk, view overlay, camera viewfinder,
media viewers) or waits on a dark Modal theme variant (the editor's
export/import dialogs and ST editor). Remaining
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
palette rather than a third one. **Owner:** okan · **Expiry:** 2027-03-31.

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
row components, and the SCADA runtime grids. **Owner:** okan ·
**Expiry:** 2027-06-30.

## Enforcement

`tests/invariants/web-design-system-ratchet.spec.ts` (layer-1 shard) +
`.claude/allowlists/web-design-system-ratchet.yaml`. `no-alert: error` for
`web/**` in `eslint.config.mjs` (override 8d).

## Out of this cycle (tracked above, not done)

- Remaining overlay entries (8 runtime surfaces; see allowlist entries).
- Hex residues: AquaMobil (9; no shared-ui import) and the pH scale (10).
- Static inline style in SCADA symbol geometry (133).
- Raw `<table>` → `DataTable`: 48 remain after batch 16 (admin-panel 3,
  tenant-admin 1, hr 3, shell 1, hydroponics 2, sensor 15, farm 23).
- Wave 2/3 of the design map (messaging to web, admin DataTable, dashboard,
  single palette across web + AquaMobil, dark mode reach, i18n reach) — design
  work with product decisions attached; not gated here.
