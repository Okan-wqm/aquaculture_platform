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
brand colour, kept as data. **Owner:** okan · **Expiry:** 2027-03-31.

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
**Owner:** okan · **Expiry:** 2027-06-30.

## Enforcement

`tests/invariants/web-design-system-ratchet.spec.ts` (layer-1 shard) +
`.claude/allowlists/web-design-system-ratchet.yaml`. `no-alert: error` for
`web/**` in `eslint.config.mjs` (override 8d).

## Out of this cycle (tracked above, not done)

- Remaining overlay migrations (see allowlist entries).
- Hex → token mapping; inline-style reduction.
- Wave 2/3 of the design map (messaging to web, admin DataTable, dashboard,
  single palette across web + AquaMobil, dark mode reach, i18n reach) — design
  work with product decisions attached; not gated here.
