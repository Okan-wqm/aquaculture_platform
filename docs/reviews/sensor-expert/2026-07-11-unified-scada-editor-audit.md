# Review Report -- Unified SCADA Editor Audit

**Date:** 2026-07-11
**Scope:** The "unified sensor system" — the Unified SCADA Editor (`web/modules/sensor-module/src/pages/unified/`), the SCADA package builder it supersedes, the unified tag registry + SCADA services (`apps/sensor-service/src/process/`, `scada-runtime/`), and the deploy path.
**Reviewer:** sensor-expert (13-agent end-to-end audit + Fable-5 cross-verification)

## Summary

The unified editor is the default editor for SCADA processes but shipped as a
thin shell over the standalone builder: its HMI mode mounted a bare widget
palette and a properties panel bound to the wrong store, so the builder's
shapes and per-widget configuration were unreachable. Beyond the user-visible
"shapes aren't there / it feels problematic" report, the audit surfaced
data-integrity, live-data, tag-lifecycle, deploy-safety and WebSocket
control-plane security defects. Findings are tracked in
`docs/reviews/_registry/findings.jsonl`; this document is the human-readable
record. Remediation is phased in
`docs/plans/` (unified-scada editor remediation plan).

---

## Findings (this document tracks the registered SENSOR-* IDs below)

### [SENSOR-HIGH-029] Unified editor HMI palette is a strict, drifted subset of the builder palette
- **File:** `web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx` (left panel), `web/modules/sensor-module/src/constants/scada-palette-categories.ts`, `web/modules/sensor-module/src/components/scada-builder/WidgetPalette.tsx`
- **Category:** Product correctness / UI parity
- **Description:** The unified editor's HMI mode mounted a bare `WidgetPalette` while the standalone builder mounts `UnifiedLeftPanel` (palette + FUXA Community Library browser + Scene Tree + Layers + search/favorites). The two palettes were hand-maintained and had drifted in both directions, and the equipment `symbolMap` registered ~48 symbols of which only ~26 were droppable — 7 widget types (knob, dropdownSelect, barChart, pieChart, dataTable, iframe, progressBar) and 26 equipment symbols (compressors, motors, filters, transmitters, extra pumps/valves) were unreachable in the unified editor.
- **Impact:** Designers using the default editor could not place large classes of shapes/widgets that ship in the codebase. This is the literal "the shapes that exist in the SCADA system are not there" report.
- **Recommendation:** Mount `UnifiedLeftPanel` in unified HMI; make `PALETTE_CATEGORIES` the single palette source of truth and a strict superset; add a palette-parity invariant asserting every palette type resolves in the `WidgetRenderer` lazy-map and every `symbolMap` symbol is reachable.

### [SENSOR-HIGH-030] Unified editor HMI properties panel reads the wrong selection store, so widget config is unreachable
- **File:** `web/modules/sensor-module/src/components/unified-editor/UnifiedPropertiesPanel.tsx`, `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx`
- **Category:** Product correctness / dead control
- **Description:** The HMI branch of `UnifiedPropertiesPanel` read `useProcessStore.selectedNode` — the P&ID iframe's selection — while the real HMI `<ScreenCanvas>` writes selection to the SCADA store's `selectedWidgetId` via `setSelectedWidget`. The panel therefore never showed the selected widget and its Config/Tag writes targeted the wrong store; the Alarms/Control/Trends/Events/Animations/Scripts tabs were entirely unreachable.
- **Impact:** HMI widgets could not be configured from the default editor — including safety-relevant control-security (PIN, emergency-stop) and alarm/trend configuration.
- **Recommendation:** Wire the builder's full `PropertiesPanel` (via `usePropertiesPanelHandlers`) to the SCADA store's `selectedWidgetId` in unified HMI mode.

### [SENSOR-HIGH-031] Unified editor Undo/Redo and editing shortcuts are dead no-ops in HMI mode
- **File:** `web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx`, `web/modules/sensor-module/src/hooks/useScadaKeyboardShortcuts.ts`
- **Category:** Product correctness / dead control
- **Description:** The unified toolbar's Undo/Redo buttons posted `undo`/`redo` messages to the P&ID iframe, which has no such handler, and the SCADA store's real history (`undo`/`redo`/`canUndo`/`canRedo`) was never invoked. `useScadaKeyboardShortcuts` was never mounted, so Ctrl+Z/Y/C/V/X and Delete did nothing in HMI mode.
- **Impact:** HMI editing in the default editor had no reachable undo history and no keyboard shortcuts — a regression from the standalone builder.
- **Recommendation:** Route the toolbar Undo/Redo (and mount `useScadaKeyboardShortcuts`, gated to HMI so it cannot mutate the hidden HMI store from P&ID mode) to the SCADA store when `mode === 'hmi'`.
