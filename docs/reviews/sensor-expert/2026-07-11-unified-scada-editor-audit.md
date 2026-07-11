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

### [SENSOR-HIGH-032] Unified editor has no in-app "play the process" simulation run mode
- **File:** `web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx`, `web/modules/sensor-module/src/components/scada-builder/SimulationSidebar.tsx`, `web/modules/sensor-module/src/store/scada/simulationSlice.ts`
- **Category:** Product capability gap
- **Description:** The standalone builder has an Edit/Preview/Simulation sub-mode that runs a client-side IEC 61131-3 ST interpreter closed-loop, drives sim tag values, evaluates alarms, and animates HMI widgets — a FUXA-style in-app run with no device deploy. The unified editor (the default editor) never called `setSimulationMode`, hardcoded `ScreenCanvas isPreview={false}`, and had no run toggle, so the process could not be played/observed in-app without deploying to hardware.
- **Impact:** Users of the default editor could not validate a process (P&ID + HMI + ST logic) by running it in simulation before deploying — the explicit "edit -> play -> observe, no deploy" workflow.
- **Recommendation:** Add an HMI-scoped Run/Stop toggle that flips `simulationMode` (keeping `StableModeProvider mode="edit"` to avoid remount) + `ScreenCanvas isPreview={simulationMode}`, and swaps the right panel to `SimulationSidebar`. (P&ID equipment-node live animation during a run is tracked separately as the more expensive follow-on.)

### [SENSOR-HIGH-033] Late-resolving linked-package query clobbers unsaved HMI edits
- **File:** `web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx`
- **Category:** Data loss
- **Description:** The linked-package adoption effect guarded only on `scadaPackageId`. Because `useScadaPackages` resolves asynchronously, a user who started editing the HMI while the query was in flight had those edits silently overwritten by `loadFromJSON(pkg.packageData)` (which also resets `isDirty=false`) when the query resolved.
- **Impact:** Silent loss of unsaved HMI widgets with no dirty warning.
- **Recommendation:** Skip adoption when the store is not pristine (`scadaDirty`).

### [SENSOR-HIGH-034] getState timeout silently persists a possibly-stale P&ID snapshot
- **File:** `web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx`
- **Category:** Data integrity
- **Description:** On a `getState` round-trip timeout, `handleSave` resolved with the (possibly stale) `canvasNodesRef`/`canvasEdgesRef` mirror and proceeded to save, masking a non-responding canvas as a successful save.
- **Impact:** A stale or empty P&ID could be persisted and reloaded later.
- **Recommendation:** Fail the save with a surfaced error on timeout; the canvas is authoritative at save time.

### [SENSOR-HIGH-035] Repeated saves on a new process spawn duplicate processes
- **File:** `web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx`
- **Category:** Data corruption
- **Description:** After the first save of a new process, `window.history.replaceState` rewrote the URL without notifying React Router, so `useParams().processId` stayed `'new'`. Because `isNewProcess` was OR-ed with `id === 'new'`, every subsequent save re-ran `createProcess`, creating duplicate processes and re-pointing the single linked package to the newest one, orphaning the rest.
- **Impact:** One logical process became many rows; only the newest carried the HMI package.
- **Recommendation:** Drive create-vs-update off the persisted identity only (drop `id === 'new'` from the predicate); guarded by a regression test.

### [SENSOR-HIGH-036] Non-atomic dual-target save marks the process clean while the package fails
- **File:** `web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx`
- **Category:** Data integrity
- **Description:** `markClean()` for the process store ran inside the process leg, before the package leg — which can throw on the 1 MB `packageData` cap or validation. On a package-leg failure the process was persisted and marked clean while the package stayed dirty and unsaved, leaving the two artifacts out of sync.
- **Impact:** Process/package divergence with a misleading clean state.
- **Recommendation:** Defer all `markClean` calls until both legs succeed.

### [SENSOR-CRITICAL-004] SCADA WebSocket control-plane JWT accepts HS256-forged tokens (RS256->HS256 algorithm confusion)
- **File:** `apps/sensor-service/src/scada-runtime/scada-runtime.gateway.ts`
- **Category:** Security / authentication (physical actuation)
- **Description:** The `/scada` gateway's hand-rolled `validateToken` verified with `algorithms: [configService.get('JWT_ALGORITHM', 'HS256')]` against the injected RS256 `JwtService`, whose verification key is the RSA public key. The per-call `algorithms` override forced HS256 verification against a public key — the textbook RS256->HS256 confusion attack. An attacker who knows the (public) JWKS key could mint an `HS256` token with any `tenantId`/`role`, connect, and issue `TAG_WRITE`/`ALARM_ACK` on any tenant's physical devices. The `jwt-rs256-only` invariant's literal-only matcher did not catch the variable-sourced allowlist.
- **Impact:** Full authentication + tenant + role bypass on the physical-actuation control plane.
- **Recommendation:** Delete `validateToken` and verify via the shared `getJwtVerifyOptions(configService)` + `enforceAccessTokenType` (RS256 + issuer + audience + token-type enforced at the library level, mirroring `sensor-readings.gateway.ts`). Broaden the invariant to ban any `JWT_ALGORITHM` verify-allowlist key.

### [SENSOR-CRITICAL-005] TAG_WRITE is not tenant-fenced and emits a tenant-less write event
- **File:** `apps/sensor-service/src/scada-runtime/scada-runtime.gateway.ts`, `apps/sensor-service/src/scada-runtime/services/tag-manager.service.ts`
- **Category:** Security / tenant isolation (physical actuation)
- **Description:** `handleTagWrite` validated only the role and a non-empty tagId, then called `writeTagValue(tagId, value, userId, fn)` with no tenant and no registry check — unlike the subscribe path, which resolves keys against the connecting tenant's registry. `TagWriteRequest`/`SCADA_TAG_WRITE_EVENT` carried no `tenantId`, so any device-driver consumer keying by `deviceCode/localName` would actuate whichever tenant's identically-named device it routed to. The gateway also ACKed `accepted` although nothing had processed the write.
- **Impact:** An authorized-role (or forged-admin) socket in tenant A could actuate tenant B's output by a predictable `deviceCode/localName`; the write event was tenant-less end-to-end; the ACK asserted a success that never happened.
- **Recommendation:** Resolve the target tagId strictly against the connecting tenant's registry (no legacy grandfathering), require a writable (non-INPUT) direction, thread a required `tenantId` through `writeTagValue`/`TagWriteRequest`/`SCADA_TAG_WRITE_EVENT`, and ACK `queued` (a confirmed ACK is gated on a real device-driver completion event). Guarded by a gateway unit test.

### [SENSOR-CRITICAL-006] Widget control-security (PIN / security level) is client-side theater and the PIN ships plaintext in packageData — OPEN (tracked)
- **File:** `apps/sensor-service/src/scada-runtime/scada-runtime.gateway.ts`, `apps/sensor-service/src/process/resolvers/process.resolver.ts` (mapScadaPackageToType), `web/modules/sensor-module/src/components/scada-operator/widgets/RuntimeInput.tsx`
- **Category:** Security / authorization (physical actuation)
- **Description:** Per-widget `controlPermissions` / PIN / security level are enforced only in the browser (`RuntimeInput.handlePinConfirm` compares `pinInput !== config.pin`), and `config.pin` is stored plaintext in `packageData`, which any authenticated tenant member can read via the `scadaPackage(s)` GraphQL query (`mapScadaPackageToType` returns `packageData` wholesale). The gateway `TAG_WRITE` handler never loads or enforces `controlPermissions`.
- **Impact:** The "supervisor + PIN" restriction has zero server-side effect; the PIN is readable by any operator; the gate is bypassable via devtools or a direct socket write.
- **Status:** OPEN — NOT fixed this session. A redaction-only slice is unsafe: removing the plaintext `pin` from the read path makes the current client-side check pass on an empty PIN, weakening the gate. The correct fix is a feature: store a salted `pinHash` (never plaintext) with a migration for existing pins; verify the PIN server-side at `TAG_WRITE` via a challenge/response WS message pair; enforce the per-widget/tag `controlPermissions` (required role / security level) at the gateway (which is now tenant+registry gated by SENSOR-CRITICAL-005). Owner: auth-security-expert. The WS tenant+role+registry gate (CRITICAL-004/005) is the primary control now in place; this is the per-widget control-security layer on top.
