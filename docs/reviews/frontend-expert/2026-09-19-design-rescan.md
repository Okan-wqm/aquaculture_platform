# Design rescan, end to end — 2026-09-19

**Agent:** `frontend-expert` (lead) with `accessibility-auditor`, `mobile-app-auditor`,
`admin-expert`, `sensor-expert`, `farm-expert`, `hr-expert` reading cold ·
**Mode:** WRITER (survey + gates + regression wave) · **Lane:** web
**Cycle:** `2026-09-19-design-rescan` · **Verdict:** CONDITIONAL
**Findings:** 22 (HIGH 13 · MEDIUM 8 · LOW 1) + 1 handed to `hr-expert`

> Finding IDs were allocated with `findings:add` in the change that lands this
> document: `FE-HIGH-073` … `FE-MEDIUM-093` and `HR-HIGH-010`. One entry,
> `HR-LOW-009` (the design-system documentation gap), was registered under the
> `HR` domain prefix by a loop error in the same session; its `owner_agent` is
> `frontend-expert` and it is listed below under that ID. The registry is
> append-only, so the prefix stays; the ID is unique and the entry is correct
> in every other field.

## Scope

A fresh survey of `web/` on `main @ e9b9d773` (1 077 non-test `.tsx` across 11
packages), run as if the 2026-09-18 waves had not happened: every metric was
recomputed from the source with independent scripts, and seven read-only
auditors were briefed without the earlier findings or the ratchet allowlists.
Backend code was not surveyed except where it renders a design surface (emails,
print, the edge gateway's static page).

## Executive summary

The thirteen waves shipped from `2026-09-18-design-system-adoption-ratchet.md`
hold: raw hex 0, browser dialogs 0, hand-drawn spinners 0, static inline styles
0, overlays 5, raw tables 12, page titles on `PageHeader`, one dark-mode
mechanism, one `@theme`. The rescan found five defects those waves left behind
and closed them in this change (`FE-HIGH-073` … `FE-LOW-077`, below).

What remains is the layer under those metrics. `shared-ui` is a token file
that almost nothing consumes and a primitive library that contradicts its own
tokens: `Button`, `Card`, `Alert`, `Header` and `Sidebar` paint from the raw
Tailwind palette, so the `primary`/`secondary`/`success`/`warning`/`error`
scales appear 25 times against 7 324 raw-palette usages. Three modules (sensor,
hr, tenant-admin) use `Button`, `Card` and `Badge` zero times. The primitives the
code needs most (Tabs, Menu, Tooltip, EmptyState, Switch, a severity scale) do
not exist, so every module re-implements them without semantics. Feedback is
silent in four modules and static in one. The shell has no small-screen
layout. Internationalisation reaches 13 files. And a set of design surfaces was
never on the map at all: transactional emails, the printed roster, the edge
gateway's page, the blank first paint.

| Census (main @ e9b9d773)                                       | Count       |
| -------------------------------------------------------------- | ----------- |
| raw `<button>` / `<Button>`                                    | 2 090 / 287 |
| raw `input`/`select`/`textarea` / Form primitives              | 1 946 / 318 |
| hand-built cards / `<Card>`                                    | 355 / 211   |
| hand-rolled status pills / `<Badge>`                           | 141 / 102   |
| raw Tailwind palette / theme scales                            | 7 324 / 25  |
| inline icon-shaped `<svg>` / files importing lucide-react      | 569 / 308   |
| pages with no responsive class (sensor, farm, hydroponics, hr) | 101 / 234   |
| files calling `t()` / i18n providers                           | 13 / 4      |
| `dark:text-gray-400` pairs that resolved to the light value    | 4 538       |
| colour utilities compiling to nothing                          | 22          |

## Closed in this change

### FE-HIGH-073 — colour utilities that compile to nothing

`tenant-600` survived in the shell after the private palette was retired
(#1595); `gray-750`/`gray-850` sat in the ST editor, touch keyboard and
simulation sidebar; `gray-150`, `gray-25`, `yellow-25` and `!bg-aqua-500` in the
delete dialog and the mobile sync page. Tailwind emits no rule for a step or a
scale it does not know, so each element painted with whatever was behind it.
All 22 rewritten to real steps; `tests/invariants/web-theme-token-parity.spec.ts`
now checks every colour utility under `web/` against `theme.css`, Tailwind's
palette, or (AquaMobil) `tailwind.config.js`. **Closed.**

### FE-HIGH-074 — muted text unreadable on dark surfaces

FE-MEDIUM-024 darkened `--color-gray-400` to `#6b7280` for white backgrounds.
Utilities resolve the variable at paint time, so every `dark:text-gray-400`
(4 538 web-wide) inherited it: 3.7:1 on gray-900, 3.0:1 on gray-800, and the
common `text-gray-500 dark:text-gray-400` pair was a no-op. `theme.css` now
assigns the token per theme (`[data-theme='dark'] { --color-gray-400: #9ca3af }`,
6.9:1 / 5.5:1); the parity spec holds both assignments to 4.5:1. **Closed.**

### FE-HIGH-075 — feeding boards showed `{t('…')}` as header text

Batch 21 serialised sixteen JSX column headers into string literals across
`MealBoardTab`, `AssignmentsTab` and `ProtocolBuilderTab`. Rewritten to the
`t()` calls already in scope. **Closed.**

### FE-MEDIUM-076 — the operator shell painted dark without saying so

`OperatorShell` is always `bg-gray-950` but never set `data-theme`, so the alarm
drawer moved onto `DataTable` (#1593) and the `dark:` pairs added in #1594
rendered a white card over the black HMI. The root now pins
`data-theme="dark"` the way `Modal`/`Drawer theme="dark"` do. Three fixed
yellow severity chips had received `dark:text-gray-100` from the pairing codemod
and became unreadable; a chip's foreground follows its own background, so the
dark half is gone. **Closed.**

### FE-LOW-077 — dead `.tenant-*` component layer

`tenant-admin` and `messaging-module` `styles.css` still carried a
`@layer components` block (`.tenant-card`, `.tenant-btn-primary`,
`.tenant-table`, …) and three `bg-tenant-*` gradient utilities with zero
consumers. Deleted; the base border-colour rule and the scrollbar styling stay.
**Closed.**

## Open findings (by severity)

### FE-HIGH-078 — the primitives do not use the tokens

`Button` is `bg-blue-600`/`bg-red-600`/`bg-green-600`; `Card` rings
`blue-500`; `Sidebar` and `Header` use `blue-50`/`blue-600`; `Alert` carries no
dark variants at all. The token SSoT therefore governs almost nothing a user
sees, and every module copies the habit (the sensor toolbar ships teal Demo, cyan
Save and indigo Deploy on one row). Fix: variant maps read `primary-*`,
`error-*`, `success-*`, `warning-*`; an ESLint rule bans raw-palette utilities
under `web/shared-ui/src/components/`. ~25 shared-ui files.

### FE-HIGH-079 — primitive adoption outside admin-panel is near zero

| Package | raw `<button>` / `<Button>` | raw fields / primitives | cards |
pills |
|---|---|---|---|---|
| sensor-module | 832 / 0 | 794 / 0 | 139 / 0 | 36 / 0 |
| farm-module | 521 / 77 | 825 / 80 | 94 / 25 | 33 / 9 |
| admin-panel | 182 / 171 | 121 / 127 | 53 / 149 | 15 / 85 |
| aquamobil | 164 / 1 | 27 / 0 | 51 / 0 | 19 / 0 |
| tenant-admin | 157 / 0 | 64 / 0 | 4 / 0 | 16 / 0 |
| hr-module | 120 / 0 | 85 / 2 | 14 / 0 | 11 / 0 |

Three incompatible field conventions live in farm alone; hr keeps private
`inputClass`/`labelClass` constants; tenant-admin has five badge components.
Reach: sensor ~181 files, farm ~117, tenant-admin ~38, hr ~36.

### FE-HIGH-151 — the form label has no linkage to its control's size

Raised while converting sensor-module fields for FE-HIGH-079, because it is the
reason those conversions kept stalling. `Input`, `Textarea`, `Select` and
`FormField` all hardcode `block text-sm font-medium … mb-1` for the label, with
no reference to the control's `size`. The control scale does move — `xs` renders
`text-xs`, `lg` renders `text-base`, `xl` renders `text-lg` — so at those sizes
the label sits one to two steps off the control beside it.

The consequence is not cosmetic. Every dense surface (filter bar, repeat row,
properties inspector, modal grid) therefore kept a hand-written
`<label class="text-xs">` *outside* the primitive, and once the label is outside,
nothing binds it: `EdgeDeviceDetailPage`'s 23-field I/O tag form had no
accessible names at all — each a bare `<label>` with no `htmlFor` beside a
control with no `id`. FE-HIGH-079 could not reach those surfaces while the
primitive could not express them.

Fix: one `fieldLabelClass(size)` SSoT the four components share, `md`/`sm`
unchanged at `text-sm` so no existing field moves, and `size` on `FormField`.

### FE-MEDIUM-152 — there is no colour-field primitive

39 call sites build one from a raw `<input type="color">`: 38 in sensor-module
(all under `components/scada-builder/` plus the channel editor) and 1 in farm.
Three shapes are in circulation — a `w-full h-8` bar, and `w-8 h-8` / `w-8 h-7` /
`w-6 h-6` swatches — each with its own border, radius and cursor classes.
13 had no accessible name; several carried an `aria-label` that contradicted a
visible label sitting above them unbound, which a screen reader resolves in
favour of the `aria-label`. farm's water-chemistry config row rendered an inert
preview div beside the picker: two identical swatches side by side, one of them
dead. `scada-builder/widget-configs/ColorAlphaInput.tsx` is a private partial
copy — it composes the missing primitive's swatch half by hand.

Fix: a `ColorInput` primitive with the two shapes those sites actually need
(`bar`, `swatch`), label bound and swatch sized from `size`, and
`ColorAlphaInput` composing it rather than re-deriving it.

### FE-HIGH-080 — operator-screen hazards

A newly raised critical alarm is signalled only visually (no live region); the
alarm summary bar is a `role="button"` div that answers Enter but not Space; the
widget palette is drag-only, so a widget cannot be placed by keyboard; tag
quality on the live input widget is colour alone. Operability blockers, not
polish: one `role="alert"` announcer mounted by the operator shell, `WidgetCard`
as a real button, `QualityIndicator` with icon + text.

### FE-HIGH-085 — the primitives the code needs do not exist

Tabs (12 hand-rolled bars, 6 with no tab ARIA), Menu/Popover (17 dropdowns,
none close on Escape or manage focus), Tooltip (34 native `title=`), EmptyState
(133 hand-built in farm), ErrorState, Switch (3 spellings), SkipToContent, and a
named `severity`/`quality`/`state` scale (10 alarm-severity colour maps in sensor
over three vocabularies). Each missing primitive is what keeps regenerating the
drift that FE-HIGH-079 counts.

### FE-HIGH-086 — mutation outcomes are invisible or inconsistent

hr, tenant-admin, hydroponics and dashboard use `useToast` and `<Alert>` zero
times: payroll approval, leave approval and clock-in succeed or fail silently.
admin-panel answers 121 `setError` calls with static top-of-page banners. farm
toasts field validation in 14 places. Payroll approve, schedule-category delete,
admin note delete and close-batch run with no confirmation while a routine feed
delete gets one. Fix at the hook layer: every `useMutation` reports through
`useToast` by default; validation lands in `FormField error`; destructive
actions pass `useConfirm({ variant: 'danger' })`.

### FE-HIGH-087 — accessibility defects inside the primitives

`DataTable` sortable headers are `<th onClick>` with no `tabIndex`, `role` or
`scope`; `ConfirmModal` renders an unnamed `role="dialog"` (~58 call sites);
`useDialogBehavior` restores focus only in the closed branch, not on unmount (21
wrappers early-return `null`); `Input`/`Select`/`Textarea` never forward
`required`; toasts carrying an action auto-dismiss in 5 s; `FocusTrap` has one
consumer; `aria-current` appears 4 times. Each is one central change.

### FE-HIGH-088 — no small-screen layout

`Sidebar` is an in-flow `w-64`/`w-16` aside with no overlay mode (111–311 px of
content on a 375 px phone); the hamburger is an unlabeled icon button;
`NotificationPanel` is a fixed `w-96` that overflows the viewport; 101 of 234
pages in sensor/farm/hydroponics/hr carry no responsive class; farm has 217
fixed `grid-cols`; the builder shells declare neither a min-width nor a
desktop-only notice.

### FE-HIGH-089 — language follows the file, not the user

Four i18n providers, 0 JSON locale files, `useI18n` in 13 files. farm ships
English, Turkish and a Norwegian Suspense fallback; sensor has 38 Turkish files
beside English builder/operator screens; hr mixes English with unaccented
Turkish; both admin panels are English-only; AquaMobil defaults to `tr` and ships
English; the shared `Header` mixes both languages in one menu; `<html lang="tr">`
is static while `AuthLayout` pins `locale="en"`. Decision recorded here:
tenant-facing surfaces are Turkish-first through `useI18n`; the SUPER_ADMIN
panel may stay English-only as a declared choice.

### FE-MEDIUM-081 — semantic tints without dark pairs

farm 786 `bg-{colour}-50/100` with 8 `dark:` siblings, admin-panel 362,
tenant-admin 237; `Alert` itself has none; `Sidebar` admin/tenant themes are
light-only; recharts tooltips hardcode white. The darkSurface ratchet covered
only `bg-white`/`gray-50`/`gray-100`; it extends to the tints once
`Badge`/`Alert`/`Card` variants carry both palettes.

### FE-MEDIUM-082 — two icon systems

569 inline icon-shaped `<svg>` (farm 220, admin-panel 127, shared-ui 86, sensor
72, shell 28) beside lucide-react in 308 files; farm imports lucide in two files
and hand-pastes twelve icons for one tab strip.

### FE-MEDIUM-083 — first paint is blank

`web/shell/index.html` ships an empty `#root` while the federation runtime and
five font families load.

### FE-MEDIUM-084 — two chart stacks

sensor-module on recharts; shared-ui on hand-rolled SVG charts; 304 hex values
in chart palettes and SCADA symbol renderers; P&ID outlines are `#333` and
captions are baked Turkish `<text>`.

### FE-MEDIUM-090 — typography split three ways

index.html loads Caveat, Geist, Geist Mono, Instrument Serif and Inter;
`theme.css` names JetBrains Mono, which is never loaded; the auth pages render on
Geist/Instrument Serif inside a 1 229-line shell stylesheet; hydroponics uses
`text-[9px]`…`[11px]`.

### FE-MEDIUM-091 — AquaMobil design layer

Konsta in 8 files beside 62 hand-rolled; `gray-400` is Tailwind 3's `#9ca3af`
(2.85:1) in 355 uses; 170 raw buttons vs 3 `IconButton`; unlabeled required
fields; a hand-rolled switch with no role; nav clearance in four values;
pull-to-refresh disabled globally with one implementation; a global
`input:focus !important` rule; a postinstall patch of konsta. Recommendation:
drop Konsta for hand-rolled + shared token values (~20 files); consuming
`web/shared-ui` on Tailwind 4 is ~90 files and reverses the standalone-lockfile
decision, so only as a separately planned convergence.

### FE-MEDIUM-092 — dead affordances and invisible state

hr renders styled controls with no handler (Add Certification, Export ×3, New
Request, View/Renew); admin-panel ships a dead `AdminLayout` with a fake search
box; tenant-admin's Export Schema has no `onClick`; the SUPER_ADMIN act-as-tenant
context persists across reloads with no banner and no exit control.

### FE-MEDIUM-093 — design surfaces outside `web/`

Three hand-built email HTML builders (notification 859 lines / 6 templates,
admin-api 867 / 6, scada-runtime 411), the edge gateway's static SCADA page
(1 627 lines, 26 hex colours), the HR print roster (an HTML string in
`window.open` with its own table, `h1` and 9 hex values), chart/PDF exports.
None share tokens; these are the surfaces a customer sees first and signs.

### HR-LOW-009 — no documentation surface

`web/shared-ui/README.md` is 0 bytes; 0 Storybook stories; 0 screenshot tests.

### HR-HIGH-010 — weekly schedule saves to localStorage only (handed to `hr-expert`)

`WeeklySchedulePage`'s "Kaydet" writes the roster to localStorage and clears the
unsaved flag; nothing reaches the scheduling API. Product-truth defect, outside
the design lane.

### FE-HIGH-094 — FUXA widget variable bindings never reached the runtime tag bus

`FuxaWidgetConfig.variableTagBindings` (variable id → tag) is configured in the
builder and read by `FuxaWidgetRenderer`, and `FuxaMessageBridge.bindTag` can
forward a bus tag into the iframe — but the renderer constructed the bridge
with a `null` bus behind a "for now" comment and never called `bindTag`, so a
bound variable kept its configured value in the runtime and the operator saw a
static figure where a live one was promised. `ScadaRuntimeContext` already
carries the `TagValueBus` the other widgets read. Product-truth defect on a
SCADA surface; found while the design ratchets reformatted the file.

## Order of work

1. **FE-HIGH-078 + FE-HIGH-085** — retint the primitives from the tokens and ship
   the missing ones (Tabs, Menu, Tooltip, EmptyState, ErrorState, Switch,
   SkipToContent, severity/quality scale). Nothing else converges without them.
2. **FE-HIGH-087 + FE-HIGH-080** — the central a11y fixes in shared-ui and the
   operator announcer; small, high-value, no product decision needed.
3. **FE-HIGH-086** — mutation feedback at the hook layer, module by module
   (hr first: payroll and leave).
4. **FE-HIGH-079** — adoption sweeps with a ratchet per package (raw button /
   raw field / hand-built card / pill), tenant-admin and hr first (smallest),
   sensor last (largest).
5. **FE-HIGH-088, FE-HIGH-089** — the shell's mobile layout and the i18n
   decision; FE-MEDIUM-081/082/083/084/090/091/092/093 and HR-LOW-009 follow.

## Method

Counts are ripgrep/python passes over non-test `.tsx` (`__tests__`, `.spec`,
`.stories`, generated code excluded) — reliable for order of magnitude, not as
exact metrics. Auditor findings were verified against the source before being
registered; two auditor claims were dropped (light-mode `text-gray-400`
contrast on the web, which FE-MEDIUM-024 already fixed at the token; a
`FocusTrap` consumer count of zero, which is one).
