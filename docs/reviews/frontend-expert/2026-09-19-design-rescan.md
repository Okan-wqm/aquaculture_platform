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
`<label class="text-xs">` _outside_ the primitive, and once the label is outside,
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

### FE-HIGH-158 — icon-only buttons ship with no accessible name

A button whose only child is an icon has no text to name it, so the name has to
come from the markup. 63 of them across `web/` carry none, and a screen reader
announces each as bare "button":

- `shared-ui/src/components/DataTable/DataTable.tsx:301` — the row expander.
- `shared-ui/src/components/Form/DatePicker.tsx:203,213` and
  `DateRangePicker.tsx:337,347` — the month-navigation chevrons.
- `shared-ui/src/components/Form/{FileUpload,MultiSelect,SearchInput,SearchableSelect}.tsx`
  — remove-file, remove-chip, clear-search and clear-selection.
- `admin-panel/src/pages/AnnouncementsPage.tsx:437` — **delete**, an
  irreversible action, and `:431` edit, `:215` refresh beside it.
- `apps/aquamobil/src/pages/HomePage.tsx:175` — **log out**.

Nine of those are shared-ui's own, which is the sharpest part: every consumer
inherits the absence from the primitive it was told to adopt.

### FE-HIGH-159 — buttons paint a state they never announce

314 buttons switch their class attribute on a selected state while the opening
tag declares that state nowhere. The selection is visible and inaudible — colour
alone, which WCAG 1.4.1 rejects. sensor-module holds 135 of them (SCADA
toolbars, the alignment and undo/redo bars, protocol and template pickers),
farm-module 52, AquaMobil 39, admin-panel 34.

By shape: 128 sit inside a `.map()` over an options array (a segmented control
or tab strip), 88 are a single `onClick={() => setX(…)}` selector, and the rest
are one-off toggles. The 216 in the first two groups want one primitive whose
`aria-pressed` comes from the same prop that paints the selection — the fix
that would make the defect impossible rather than merely visible.

The first count here was 329. Fifteen of those declare `aria-checked`, which is
the correct attribute for `role="switch"`, `role="radio"` and `role="checkbox"`
— a report-settings switch, the scheduling week pickers, two water-chemistry
toggles — and the detector simply did not look for it, nor for `aria-expanded`
on a disclosure. An inflated ceiling is as wrong as a missing one, so the
detector was widened rather than the sites changed.

### Both: the count belongs in the gate, not in this document

Four hand-written passes over this corpus produced four different totals, each
wrong in a new way, before the numbers above settled:

1. A case-insensitive `<button` matched `<Button>`, the primitive itself, and
   counted 835 where 237 existed.
2. Reading the opening tag up to the first `>` cut it at the `>` inside
   `onClick={() => …}`, so an `aria-label` after an arrow function was invisible
   and the rest of the element parsed as body.
3. Treating an expression as text when its _condition_ was an identifier counted
   `{open ? <X /> : <Menu />}` as labelled and hid every icon-only toggle.
4. Requiring a bare identifier instead counted `{date.getDate()}` and
   `{isLoading ? loadingText : confirmText}` as icon-only, inflating shared-ui's
   ceiling by four buttons that do render words.

Regex over JSX cannot be trusted to produce a number a finding can assert. Both
counters therefore live in `tests/invariants/web-design-system-ratchet.spec.ts`
as element-aware scans with brace- and quote-depth tracking, ratcheted per
package. The count is then exact by construction, a false positive shows up as a
red build rather than a wrong sentence, and neither defect can grow.

Unlike the `rawButton` ratchet beside them, both read shared-ui as well: a
primitive may render a raw `<button>`, but not one a screen reader cannot name.

### FE-MEDIUM-157 — there is no range/slider primitive

19 call sites build one from a raw `<input type="range">`: 17 in sensor-module
(SCADA builder widget configs, the canvas toolbar, the simulation sidebar, the
slider widget renderer and the dashboard background control), 1 in admin-panel
and 1 in hydroponics. Three accent hues are in circulation — `accent-info-600`,
`accent-info-500` and the browser default — and two sites force the element down
to a 4–6px hit area (`h-1`, `h-1.5`), which on a range input is the pointer
target, not the track's paint.

`hydroponics-module/.../pid-simulator/components/ControlPanel.tsx` is the
clearest evidence: it declares a private `Slider` component with exactly the API
the design system should have shipped (`label`, `value`, `min`, `max`, `step`,
`unit`, `onChange`, `disabled`) and 11 call sites already use it. A module built
the primitive itself because shared-ui had none — and the private copy reproduced
the accessibility gap too, rendering its label as a `<span>` bound to nothing.

The readout is re-derived everywhere it appears, in three placements: beside the
label (hydroponics, and `Position ({n}%)` folded into the label text in
GradientEditor), below the track right-aligned (StrokeConfig, RasterImageConfig,
CustomSvgConfig, SvgPathConfig), and below left-aligned (SvgShapeConfig ×3).

Two further defects the conversion surfaced:

- **The DOM value is parsed by hand at all 19 sites, and not the same way
  twice** — `parseInt` in admin-panel, `parseFloat` in hydroponics and the
  dashboard, `Number` everywhere else. On a fractional step `parseInt`
  truncates silently, so this is a correctness surface, not a formality. A
  primitive whose `onChange` hands back a number removes it entirely.
- **Six sites carry an `aria-label` that differs from the visible label beside
  them** — visible `Opacity` against `Stroke opacity` / `Image opacity` /
  `SVG opacity` / `Fill opacity`, and visible `Inner Radius Ratio` against
  `Inner radius ratio`. A screen reader announces only the `aria-label`, so the
  two names disagree (WCAG 2.5.3). Binding the visible label is both the fix and
  one fewer copy of the same words.

Fix: a `Slider` primitive carrying the three readout placements those sites
actually use, a label bound and sized from `size`, an `onChange` that yields a
number, and no imposed track height — 17 of the 19 never set one, and the two
that did were shrinking their own hit area.

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

### SENSOR-HIGH-128 — a SCADA data feed dies silently

**Severity:** HIGH · **Owner:** @okan-wqm · **Deadline:** 2026-10-31

Two defects that compound into the worst shape a process display can take. `HybridDataProvider` and
`LiveDeviceDataProvider` each call `connect()` on the `getScadaSocketService()` singleton and never
disconnect; `OperatorBootstrap`'s effect cleanup called `disconnect()` unconditionally. Unmounting
the bootstrap therefore tore the socket out from under whichever provider was still reading. And the
disconnect was unobservable: `_connectionState` was private with a getter and no subscription, so
both providers read it during render — a value that changes outside React's knowledge — and
`GlobalAlarmBanner` contained no reference to the connection at all.

An operator saw readings frozen at their last value with nothing saying the link was down. On a
process display "no alarms" and "no link" look identical, and only one of them is safe to imply.

Fixed by refcounting ownership and adding a subscription surface. The operator route's own banner is
**SENSOR-MEDIUM-129**, separately, because `OperatorShell` is the alarm panel and early-returns when
closed — a banner there would vanish at exactly the moment it is needed.

### SENSOR-MEDIUM-129 — the operator route still shows nothing when its link drops

**Severity:** MEDIUM · **Owner:** @okan-wqm · **Deadline:** 2026-10-31

`useScadaConnectionState` makes the transition observable and the builder route reports it, but the
operator station — where a frozen reading matters most — has no banner. Blocked on where in the
operator chrome it belongs, which is a product call rather than a code one.

### FE-MEDIUM-162 — the select conversion rendered option labels by a rule the compiler does not use

**Severity:** MEDIUM · **Owner:** @okan-wqm · **Deadline:** 2026-11-30

Seven option labels reached the branch with their words run together. `{eq.name} ({eq.code})` became
`${eq.name}(${eq.code})`, so an operator picking equipment in the process editor read
`Equipment-A(EQ-01)`; `State {s}` became `State${s}`; `[{screen.screenType}] {screen.name}` lost the
space after the bracket. The same shape hit the SCADA sensor dialog, the edge-device picker, the
ticket assignee list and the shift picker.

The cause is one line. Moving an `<option>`'s children into a `label:` value rendered each text part
with `.strip()`, where the compiler renders a text node by a published rule: a line keeps its leading
spaces only if it opens the node and its trailing spaces only if it closes the node, whitespace-only
lines vanish, and every surviving line but the last gains one space. Under that rule the space before
`(` is content and the space after `State` is content; under `.strip()` neither is distinguishable
from indentation.

Two further defects of the same shape surfaced while repairing it, both in how the option's children
were read rather than in what they meant. The children were split by a regex treating `{…}` as flat,
so an option whose label held a template literal — ``{ICONS[t] ? `[${t}] ` : ''}`` — was torn in
half. And the mapped array was captured with `(.*?)` starting at the leftmost `{`, so an option list
preceded by a placeholder holding an expression swallowed the markup between them and put `</option>`
inside an `options` prop. That second one had already been seen once and worked around by excluding
two files; the exclusion hid it rather than fixing it, and it returned in a third file.

Nothing reached `main`: the damage was confined to `c64c0c379` on the feature branch and to two labels
in the batch behind it. It was found because a fifth file failed to convert — no gate saw it, and no
gate can: the ratchet counts raw `<select>`, and a converted one with a wrong label counts as adopted.

### FE-MEDIUM-161 — the hardcoded-string ratchet cannot see a string in an object literal

**Severity:** MEDIUM · **Owner:** @okan-wqm · **Deadline:** 2026-11-30

The counter matches JSX text between tags and a short list of attributes. A string inside an object
literal matches neither, so `<option value="horizontal">Horizontal</option>` counts and
`{ value: 'horizontal', label: 'Horizontal' }` does not — though both put the same word on screen.

Measured across `web/`: **4 483** user-visible strings sit in `label` / `placeholder` / `title` /
`description` / `header` keys of object literals and are invisible to the gate — sensor-module 1 746,
farm-module 1 303, admin-panel 413, hr 285, hydroponics 280, AquaMobil 184, tenant-admin 168.

Two consequences, and the second is the serious one. A conversion that moves a string from JSX
children into an options array _lowers_ the count without removing a string: moving nine raw
`<select>` onto shared-ui `Select` for FE-HIGH-079 took 28 option labels out of the counter's sight
and sensor-module fell 3 222 → 3 196 with nothing leaving the product. And a **new** hardcoded option
label cannot be caught at all, which is what the ratchet exists to prevent.

Closing it means teaching the counter to read object-literal values and repinning every package
upward — recording strings that were always there. It belongs with FE-HIGH-089.

### FE-MEDIUM-160 — the VFD wizard's assignment pickers can never be used

**Severity:** MEDIUM · **Owner:** @okan-wqm · **Deadline:** 2026-11-30

`VfdBasicInfoStep` renders three dropdowns under **Atama (Opsiyonel)** — Çiftlik, Tank/Havuz,
Pompa. Each contains one entry, `Seçiniz...`, followed by a comment: _"Farm options would be loaded
dynamically"_. Nothing loads them. `sensor-module` has no farm, tank or pump query anywhere — no
hook, no GraphQL document — so the operator can open each control, read the placeholder, and close
it again. `farmId`, `tankId` and `pumpId` are typed on the VFD payload, so the backend is waiting
for a value the UI cannot produce.

Found while converting raw `<select>` markup onto shared-ui `Select` for FE-HIGH-079, and left
untouched on purpose. Rendering them as `Select options={[]}` would keep the same lie inside a
better wrapper, and deleting the section is a product decision about whether VFD assignment belongs
in the registration wizard at all. Closing this means wiring the three to real data — which needs
queries sensor-module does not have today — or taking the section out.

### FE-HIGH-094 — FUXA widget variable bindings never reached the runtime tag bus

`FuxaWidgetConfig.variableTagBindings` (variable id → tag) is configured in the
builder and read by `FuxaWidgetRenderer`, and `FuxaMessageBridge.bindTag` can
forward a bus tag into the iframe — but the renderer constructed the bridge
with a `null` bus behind a "for now" comment and never called `bindTag`, so a
bound variable kept its configured value in the runtime and the operator saw a
static figure where a live one was promised. `ScadaRuntimeContext` already
carries the `TagValueBus` the other widgets read. Product-truth defect on a
SCADA surface; found while the design ratchets reformatted the file.

### PROC-MEDIUM-037 — the debt-plan mirror went stale on every registry mutation

**Severity:** MEDIUM · **Owner:** @okan-wqm · **Deadline:** 2026-10-31

`docs/plans/2026-06-18-enterprise-grade-debt-closure/{manifest.json,finding-truth-table.md,README.md}`
are derived from `findings.jsonl` — five scalars and an id list. Every mutating `finding-registry`
subcommand moves at least one of them, and nothing in the mutation path refreshed the mirror:
`repin-debt-plan.ts` was a separate npm script, so consistency rested on the operator remembering a
second command. `enterprise-grade-debt-plan-contract.spec.ts` caught it, but a commit later, in CI,
on a number nobody chose to change.

It shipped red four times. Twice inside the three-file edit — recorded in the repin script's own
header — and then twice more as a forgotten invocation, at `2c6156488` and `c7a1a6079`, which is the
same bug one level up: collapsing three hand edits into one script left the script in human memory.

Fixed by moving it from tier 3 to tier 2: `runRegistryMutation`, the single wrapper every mutating
subcommand already routes through, repins after the mutation reports success. The ledger is
append-only, so a repin that refuses is a non-zero exit naming the remaining manual step, never an
undone mutation. Gated on the ledger's bytes actually changing, so `--dry-run` stays dry.

### FE-MEDIUM-163 — two action blues

**Severity:** MEDIUM · **Owner:** @okan-wqm · **Deadline:** 2026-11-30

60 action surfaces paint the informational scale as their accent, so the product shows two blues
that both read as "this is the action": the primitive's `primary-600` and the info scale beside it.

### INFRA-HIGH-189 — the aria-kernel gate never reaches a verdict on an active branch

**Severity:** HIGH · **Owner:** @okan-wqm · **Deadline:** 2026-10-31

`aria-kernel.yml` sets `concurrency.cancel-in-progress: true` on a branch-scoped group while
budgeting `timeout-minutes: 110` for a suite the same file measures at 3539 s. A branch that pushes
more often than the suite takes cancels the run every time. All 16 runs before the current one on
`claude/wonderful-archimedes-msrlg9` completed as `cancelled` — none as success or failure — while
the branch carried a real change to `aria_kernel/security/grant.py`.

Same class as FARM-MEDIUM-303: configured, never executed to completion, and invisible because a
cancelled run is not a red check, so nothing blocks the merge.

### FE-MEDIUM-164 — the hardcoded-string counter is blind to HTML entities

**Severity:** MEDIUM · **Owner:** @okan-wqm · **Deadline:** 2026-11-30

The counter's JSX-text character class excludes the semicolon, so a user-visible string written with
an entity — `People &amp; access` — does not register as user-visible text. The ratchet therefore
certifies a package that added an untranslated string.

### FE-MEDIUM-165 — the hardcoded-string counter reads a ternary chain as text

**Severity:** MEDIUM · **Owner:** @okan-wqm · **Deadline:** 2026-11-30

A nested JSX ternary chain is matched as user-visible text, so refactoring one branch of a
conditional render raises a package's count with no string added. Hit live while fixing
SENSOR-HIGH-128: `GlobalAlarmBanner` rose 3196 → 3198 because `) : alarmStateUnknown ? (` and
`) : isEmpty ? (` were each counted as a visible string. Lifting the decision into a named `centre`
variable removed the false positive, which is a better shape anyway — but a counter that moves on a
pure refactor is measuring the wrong thing, and treating that luck as the fix would hide it.

### FE-MEDIUM-166 — the nav icon table could not be reused, so it was copied

**Severity:** MEDIUM · **Owner:** @okan-wqm · **Deadline:** 2026-11-30

`Sidebar`'s private `defaultIcons` was a `Record` of RENDERED nodes — `<House
className="w-5 h-5" aria-hidden="true" />` — which pins the size into the table. A second
consumer drawing nav icons at any other size therefore cannot use it, and has two options: fork the
component, or transcribe its own table. The SUDERRA rail took the second, arriving with 42 icon
names × 4 SVG path `d` strings written into the file plus its own alias map — a second icon
vocabulary that drifts from the first silently, and exactly what the `inlineIconSvg` ratchet exists
to keep out of `web/`.

The defect is the table's shape, not the copy. A registry that cannot be resized is a registry that
will be duplicated. It now holds components and each consumer sizes them.

### FE-HIGH-167 — the tenant console lost its approved design

**Severity:** HIGH · **Owner:** @okan-wqm · **Deadline:** 2026-11-30

The SUDERRA Tenant Console and the AquaMobil v4 surface were designed, approved and running on
`feat/suderra-session-20260917`; 144 files of that work are absent from main, among them
`SuderraSidebar.tsx` and the `sd-components` stylesheet the console pages are built on. The
design-system waves replaced the console's chrome with the generic shell `Sidebar`, so a tenant now
sees the platform's default layout where an approved product surface used to be.

That is a product-truth regression rather than a styling preference: the surface the customer signed
off on is not the surface that ships. It is being restored in parts, each on the design system
rather than beside it — wave 34a lands the rail; the remaining ~1060 lines of `sd-components`,
tenant-admin's 13 pages and AquaMobil's 97 absent files are still open.

### FE-MEDIUM-168 — the tenant console ignores the theme switch

**Severity:** MEDIUM · **Owner:** @okan-wqm · **Deadline:** 2026-11-30

The console stylesheet defines its colours from `--color-sd-*` with no `[data-theme='dark']`
redefinition, so every console surface renders light whatever the user chose. It is the one page in
the product that ignores the switch, and the surface most likely to be read at night, because it is
where the alarms are.

The gap is invisible to the ratchets **by construction**: `darkSurface` counts a Tailwind light
class with no `dark:` sibling, and the console is built from plain CSS classes — so a page can be
entirely light-only while the counter sits at its ceiling of 0. Same blind-spot class as
FE-MEDIUM-164: the detector's input shape, not the defect, decides what it can report.

Fixed by redefining 25 tokens under `[data-theme='dark']`, which themes the whole 1058-line sheet at
once because every rule already reads tokens and carries zero raw hex — the payoff of tokenising it
before landing it. That leverage is also the risk, so `suderra-console-contrast.spec.ts` reads the
palette out of `theme.css` and asserts AA for text that carries meaning.

### FE-MEDIUM-169 — the console's landing page is hardcoded English

**Severity:** MEDIUM · **Owner:** @okan-wqm · **Deadline:** 2026-11-30

`TenantDashboard` is the first page a tenant sees after login, and it wrote all 24 of its
user-visible strings into the file — stat titles, section headings, empty states, the error banner,
the billing cycle and status vocabulary. So the landing page was English whatever the user chose.

The locale maps were never the obstacle: `en` and `tr` carry identical key counts. The page simply
never asked them anything, which is the console-wide shape — 1 of tenant-admin's 42 files calls
`t()`.

Fixed for this page; **FE-HIGH-089 stays open** for the other 41 and the 487 strings still in them.
Four of the strings are interpolated, which is the shape that resists a naive sweep because a
template literal fixes English word order; they go through `t()`'s variable form.

### FE-MEDIUM-170 — the console's landing page wears the platform default

**Severity:** MEDIUM · **Owner:** @okan-wqm · **Deadline:** 2026-11-30

`TenantDashboard`'s structural wrappers — page, error banner, stat grid, cards, card heads, the
two-column body — were the platform's default Tailwind surfaces rather than the approved Tenant
Console ones. The stylesheet defining those surfaces was present; the page simply did not use it.

Fixed by moving the wrappers onto `sd-*` while **keeping** `PageHeader` and `Button`: the mockup's
own version of this page has no `PageHeader` and 5 raw `<button>`s, and both ceilings are pinned
exactly, so importing it would have raised two ratchets to apply a skin. **FE-HIGH-167 stays open**
for the other 11 pages.

### PROC-MEDIUM-038 — the `Closes:` gate checks that a trailer exists, not that it is true

**Severity:** MEDIUM · **Owner:** @okan-wqm · **Deadline:** 2026-11-30

`commit-msg-validator` requires a `Closes:` trailer on every `fix`/`security`/`feat` commit and
validates its _shape_. It cannot check whether the commit closes what it names. For incremental work
against a large OPEN finding — one page of a twelve-page console, one file of forty-two — the
nearest valid id is the parent, so the gate's own pressure points at a false close.

It happened **twice in one session**: a commit claiming `Closes: FE-HIGH-089` with 41 files still to
go, and one claiming `Closes: FE-HIGH-167` with 11 pages still to go. Both were caught by re-reading
before pushing, which is not a control.

A falsely closed parent is worse than a missing trailer: the registry reports the work done, the
`RESOLVED` row carries a real commit sha, and nothing downstream tells it from a genuine closure —
the exact audit theatre the traceability rule exists to prevent. Candidate fixes: a finding that
declares itself a PARENT only a reconcile over its children may close, or a `Progresses:` trailer so
incremental work has an honest one to use.

### ARIA-HIGH-187 — six dormancy waivers shared one expiry and lapsed together

**Severity:** HIGH · **Owner:** @okan-wqm · **Deadline:** 2026-10-31

Six of the eight waivers in `control-reachability.dormant.json` carried the identical
`expires_on` of 2026-09-20. They lapsed at the date rollover and
`test_a_waiver_expires_against_the_clock_not_against_a_regex` went red — which blocks
`aria-kernel` on every branch and on main. No code changed; only the calendar.

Caught on PR #1629: the same commit tree passed `aria-kernel` at 23:05 on the 20th and failed at
00:50 on the 21st, with a merge in between that touched no ARIA file.

The file's own history records this failure mode one layer up — its test docblock notes that
"twenty-five TypeScript waivers reached one shared expiry together", and the fix then was to give
each waiver an owner, a reason and an id. That did not address the _clustering_, and six new
waivers promptly rebuilt it. A cliff turns a per-control review prompt into a repo-wide outage.

Unblocked by staggering the six across three dates chosen by what each actually waits on, not by
moving them as a block. The outage is closed; **ARIA-MEDIUM-188 carries the prevention**, because
staggering is a mitigation and nothing yet stops the next batch from sharing a date.

**Renumbered 2026-09-25, 182 → 187.** Raised here as `ARIA-HIGH-182`, the next free
ARIA sequence when this branch appended it. Main's ARIA lane had allocated 182 to a
different finding — a native dispatch that wrote no drain summary — and landed it
with a closing commit, so main keeps the sequence and this row moves. `dbc831b69`'s
`Closes:` trailer still names `ARIA-HIGH-182`; that id is live on main under a
different review file, so the alias sidecar cannot carry it and the force-push ban
rules out amending the trailer. See the infra-expert 2026-09-20 review for the same
dead end hit in the other direction.

### ARIA-MEDIUM-188 — nothing stops waivers from sharing an expiry date

**Severity:** MEDIUM · **Owner:** @okan-wqm · **Deadline:** 2026-11-30

`test_control_reachability` enforces that every waiver names an owner, a reason, a deadline and a
finding id, and that the deadline is checked against the clock rather than a regex. It does not
constrain the _relationship between_ deadlines, so six waivers written in one sitting shared one
date and turned a per-control review prompt into a repo-wide outage (ARIA-HIGH-187).

**Confirmed on main, four days later.** Main fixed the same outage independently in
PR #1663 (`d85679a62`) by renewing all six waivers to one shared `2026-10-20`. That
is the cliff rebuilt a third time, on main, by people who had just been woken by it
— which settles the argument that per-waiver authorship is enough. Nothing in the
gate objected, because nothing in the gate can see the relationship between two
deadlines. This branch's staggering supersedes that renewal in the merge.

This is the second occurrence of one pattern — the first was the twenty-five TypeScript waivers the
test's own docblock records — and the fix applied then (owner + reason + id per waiver) addressed
authorship, not clustering.

Two candidates, both a gate where the present arrangement is a habit: refuse a waiver whose
`expires_on` equals another's unless both declare themselves one decision (the skill-genesis trio is
the legitimate case and would carry that declaration, making the coupling readable instead of
coincidental); or escalate ARIA-MEDIUM-128's seven-day doctor warning when several waivers share a
day, so a cliff announces itself as a cliff rather than as N separate reminders.

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
