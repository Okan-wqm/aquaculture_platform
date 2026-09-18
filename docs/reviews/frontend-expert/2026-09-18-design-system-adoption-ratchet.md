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
and tenant-admin's private `useFocusTrap` deleted. Remaining files are listed
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
count (the spec rejects slack). **Owner:** okan · **Expiry:** 2027-03-31.

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
