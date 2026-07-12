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

### [SENSOR-HIGH-037] Multiple SCADA packages can link to one process; adoption is arbitrary and orphans the rest
- **File:** `apps/sensor-service/src/process/entities/scada-package.entity.ts`, `apps/sensor-service/src/database/migrations/1806000000000-ScadaPackageProcessUnique.ts`
- **Category:** Data integrity
- **Description:** `scada_packages.process_id` had no uniqueness, so duplicate-process / failed-then-retried saves could leave several packages sharing a `process_id`; reload adopted `linkedPackages[0]` (arbitrary) and later saves orphaned the rest.
- **Impact:** A process could have several linked packages; only one was ever adopted/written, the others silently diverged.
- **Recommendation:** A partial unique index `UNIQUE (tenant_id, process_id) WHERE process_id IS NOT NULL`, preceded by a dedup that keeps the newest package per process and unlinks the rest.

### [SENSOR-MEDIUM-016] Unified editor device selection is local-only and lost on save
- **File:** `web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx`, `web/modules/sensor-module/src/store/scada/projectSlice.ts`
- **Category:** Data loss / workflow
- **Description:** The toolbar device selector wrote a local `useState`, never the scada store, so `meta.edgeDeviceId` serialized as null and the choice was lost on save; the tag browser and ST autocomplete saw no device.
- **Impact:** The chosen deploy/target device was not persisted and did not rehydrate on reload.
- **Recommendation:** Bind the selector to the store's `targetDeviceId`/`setTargetDeviceId` (which round-trips via `meta.edgeDeviceId`) and mark the store dirty on change.

### [SENSOR-HIGH-038] SCADA socket heartbeat watchdog falsely trips after 35s and blocks tag writes
- **File:** `web/modules/sensor-module/src/services/ScadaSocketService.ts`
- **Category:** Connection reliability / control path
- **Description:** The 35s liveness watchdog reset ONLY on a `HEARTBEAT` frame, which the server never pushes on its own (it only echoes a client heartbeat), and the client sent none. A healthy socket streaming `TAG_VALUES` still tripped `connectionState` to `error` after 35s; since `writeTagValue` rejects on `!isConnected`, every operator tag write was then blocked by a phantom disconnect.
- **Impact:** Control writes silently blocked on a live connection; connection indicators lied.
- **Recommendation:** Reset the watchdog on ANY inbound frame, and emit a periodic client heartbeat (15s) the server echoes so idle-but-connected sockets stay healthy. Guarded by a fake-timer test.

### [SENSOR-HIGH-039] Alarm acknowledgement is a success-shaped no-op: the gateway logs but never forwards to the alarm engine
- **File:** `apps/sensor-service/src/scada-runtime/scada-runtime.gateway.ts`, `apps/sensor-service/src/scada-runtime/services/alarm-engine.service.ts`
- **Category:** Safety / false completion
- **Description:** `handleAlarmAck` / `handleAlarmAckAll` validated + logged the ack, then `// TODO: Forward to AlarmEngineService` — nothing changed the authoritative alarm state, so the alarm stayed active on every client and in storage while the operator believed it was acknowledged.
- **Impact:** Acknowledging a (potentially critical) alarm was a silent no-op — a false completion on a safety-relevant action.
- **Recommendation:** Forward the ack to `AlarmEngineService.acknowledgeAlarm`/`acknowledgeAll` (which persist + re-broadcast the AlarmStatusSummary). Because the engine already depends on the gateway (circular), cross the boundary with a tenant-scoped `scada.alarm.ack[_all]` event the engine consumes via `@OnEvent`.

### [SENSOR-HIGH-040] All useRealtimeData consumers subscribed under one shared id, so mounting/unmounting one widget stomped the others' tag subscriptions
- **File:** `web/modules/sensor-module/src/hooks/useRealtimeData.ts`, `web/modules/sensor-module/src/providers/LiveDeviceDataProvider.tsx`, `web/modules/sensor-module/src/providers/HybridDataProvider.tsx`, `web/modules/sensor-module/src/types/scada-runtime.types.ts`
- **Category:** Realtime correctness / lost subscriptions
- **Description:** `IDataProvider.subscribeToTags`/`unsubscribeFromTags` took only a tag list, and every `useRealtimeData` consumer subscribed under a single fixed provider id (`'__live_provider__'`). The `TagSubscriptionManager` ref-counts per subscriber id, so all concurrently-mounted consumers (operator view, header, charts) collapsed onto one bucket: when any one unmounted it recomputed and re-subscribed the shared set, silently dropping tags other mounted consumers still needed; the last consumer to (re)subscribe won.
- **Impact:** With more than one live-data consumer on screen, some widgets silently received no updates (or lost them when a sibling unmounted) even though the socket was healthy and "connected".
- **Recommendation:** Give `subscribeToTags`/`unsubscribeFromTags` a required `componentId` and derive a stable per-hook id from `React.useId()` so each consumer ref-counts independently; the simulation provider keeps no-op signatures. Guarded by a regression test asserting two consumers get distinct ids and unsubscribe by their own id.

### [SENSOR-HIGH-041] SCADA design / process / editor-mode zustand singletons are not reset on tenant switch or logout
- **File:** `web/modules/sensor-module/src/store/scada/createScadaStore.ts`, `web/modules/sensor-module/src/store/processStore.ts`, `web/modules/sensor-module/src/store/editorModeStore.ts`
- **Category:** Security / tenant isolation (cross-tenant data bleed)
- **Description:** The SCADA design store (`useScadaPackageStore` — screens, alarm rules, control permissions, scripts), the process store (`useProcessStore` — the P&ID nodes/edges), and the editor-mode store are single-active, tenant-owned singletons living in the federated sensor-module. Realtime sockets and the sensor/edge caches already self-register `registerLogoutCleanup`/`onTenantChange` teardown, but these three design stores did not: only `queryClient.clear()` ran on logout. On a tenant switch (A -> B) or a logout-then-login on the same browser, tenant A's in-progress design lingered and could surface in — or be saved into — tenant B's session.
- **Impact:** Tenant A's SCADA/P&ID design could be viewed under tenant B and persisted to B's tenant (cross-tenant data bleed on the same browser).
- **Recommendation:** Co-locate `registerLogoutCleanup`/`onTenantChange` cleanup with each store's singleton definition (matching the socket/sensor-store convention), fully resetting each on both channels; add a `reset` action + extracted initial-state constant to the editor-mode store, which had none. `onTenantChange` fires only on an actual A->B change (never first login), so a full reset is safe. Guarded by a regression test that dirties all three stores and asserts each resets on both a fired tenant switch and a fired logout.

### [SENSOR-HIGH-042] Client subscription teardown strands server-side subscriptions: reset() clears local ref-counts without emitting TAG_UNSUBSCRIBE
- **File:** `web/modules/sensor-module/src/services/TagSubscriptionManager.ts`
- **Category:** Realtime correctness / resource leak
- **Description:** `TagSubscriptionManager.reset()` (called on `LiveDeviceDataProvider`/`HybridDataProvider` teardown) cleared `componentTags`, `tagRefCounts`, `activeServerTags`, and the pending sets without emitting `TAG_UNSUBSCRIBE` for the tags still active on the server. Because the `/scada` socket is a shared singleton that stays connected across a provider unmount (it is torn down only on logout / tenant switch), the server kept those subscriptions and continued streaming tags no client wanted; a later mount created a fresh manager and re-subscribed on top.
- **Impact:** Server accumulated orphaned tag subscriptions and wasted fan-out bandwidth for every provider mount/unmount cycle within a session.
- **Recommendation:** In `reset()`, flush an unsubscribe (`onFlush([], activeServerTags)`) for every still-active server tag before clearing local state; a logout teardown where the socket is already gone makes the emit a harmless no-op. Guarded by unit tests asserting reset emits the unsubscribe for active tags and emits nothing when the server holds none.

### [SENSOR-MEDIUM-017] Client can write a package's status via the update input, forging PUBLISHED or un-archiving a deleted package
- **File:** `apps/sensor-service/src/process/dto/scada-package.dto.ts`, `apps/sensor-service/src/process/services/scada-package.service.ts`
- **Category:** Security / deploy-state integrity
- **Description:** `UpdateScadaPackageInput` exposed a client-writable `status` field, and `updateScadaPackage` applied it verbatim (`if (input.status !== undefined) pkg.status = input.status`). Package lifecycle is otherwise server-owned — DRAFT on create, PUBLISHED via the deploy path (`markPackagePublished` / edge confirmation on the bundle path), ARCHIVED via `deleteScadaPackage`. The writable field let any caller with update rights mark a never-deployed package `PUBLISHED` (deploy-state fakery) or flip an `ARCHIVED` (soft-deleted) package back to `DRAFT`, bypassing the deploy state machine. No frontend caller ever sent it.
- **Impact:** Package deploy state could be forged; a soft-deleted package could be silently un-deleted, both without touching a device.
- **Recommendation:** Remove `status` from `UpdateScadaPackageInput` (tier-1: the field no longer exists in the GraphQL schema) and drop the assignment in the service; status stays owned by the create/deploy/delete lifecycle methods. Regression test asserts an injected `status` on the update object is ignored and an ARCHIVED package stays archived.

### [SENSOR-HIGH-043] A soft-deleted (ARCHIVED) SCADA package or process can still be deployed to a live device
- **File:** `apps/sensor-service/src/process/services/scada-package.service.ts`, `apps/sensor-service/src/process/services/process.service.ts`
- **Category:** Deploy safety / lifecycle (physical actuation)
- **Description:** `deleteScadaPackage` and the process delete are soft-deletes (status -> ARCHIVED), but no deploy entrypoint checked status before pushing to the edge. `deployScadaPackageToEdge`, `deployScadaWithAutomation`, and `deployProcessToEdge` each loaded the row and proceeded to the broker regardless of an ARCHIVED status, so a deleted package/process could be (re)deployed and start running physical hardware.
- **Impact:** A deleted SCADA package/process could be pushed to a device and actuate hardware, contradicting its deleted state.
- **Recommendation:** Guard every device-push entrypoint on status: a shared `assertPackageDeployable` (throws on ARCHIVED) at the top of both package-deploy methods, and an inline ARCHIVED check in `deployProcessToEdge`, all before touching the broker. Regression spec covers all three entrypoints.

### [SENSOR-MEDIUM-018] resolveTagRefs accepts an unbounded refs array (single-query amplification vector)
- **File:** `apps/sensor-service/src/process/resolvers/unified-tag.resolver.ts`
- **Category:** Availability / input validation
- **Description:** The `resolveTagRefs` GraphQL query took `refs: [String]` with no size limit and passed it straight into `TagResolutionService.resolve`, which builds a single `IN (...)` lookup. Because `@Args` scalar-list arguments are not covered by the class-validator ValidationPipe, a caller could submit 100k+ refs in one query and force one enormous DB query — a cheap amplification vector at the tenant trust boundary.
- **Impact:** A single crafted query could pin a DB connection with an oversized `IN (...)` scan.
- **Recommendation:** Cap the list at `MAX_TAG_REFS_PER_QUERY` (1000 — far above a real screen/package's few hundred) and reject anything larger with a `BadRequestException` before hitting the resolution service. Regression spec pins reject-over-cap (service not called) and pass-at-cap.

### [SENSOR-MEDIUM-019] discoverTags drops zero-valued engineering ranges and alarm limits via a truthiness guard
- **File:** `apps/sensor-service/src/process/services/unified-tag.service.ts`
- **Category:** Correctness / data loss
- **Description:** Tag discovery converted each numeric I/O limit with `io.engMin ? Number(io.engMin) : undefined` (and the same for engMax, alarmHH/H/L/LL, deadband). Because `0` is falsy, a legitimate zero — a 0-100% level sensor's `engMin=0`, or a low-low alarm at `0` — was silently mapped to `undefined`, so the discovered UnifiedTag lost limits the edge should enforce.
- **Impact:** Zero-valued ranges/alarm thresholds vanished from discovered tags, weakening alarm/scaling behavior downstream.
- **Recommendation:** Convert with a null-check that preserves zero (`value != null ? Number(value) : undefined`) via a shared `numberOrUndefined` helper. Regression spec pins that engMin/alarmL/deadband=0 survive and that null/undefined still map to undefined.

### [SENSOR-MEDIUM-020] createTag/updateTag do not validate fqn against the TagRef grammar, allowing unresolvable "ghost" registry rows
- **File:** `apps/sensor-service/src/process/dto/unified-tag.dto.ts`
- **Category:** Data integrity / validation
- **Description:** `CreateTagInput.fqn` and `UpdateTagInput.fqn` had only `@IsString()` + `@MaxLength`, with no check against the canonical TagRef grammar (`deviceCode/localName`, the SSoT `TAG_REF_PATTERN` in `@platform/sensor-contracts`). A caller could persist a tag whose fqn violates the grammar (no device segment, whitespace, a second slash), which `TagResolutionService.resolve` then classifies `INVALID_GRAMMAR` at every deploy/subscribe — a permanently unresolvable row.
- **Impact:** The registry could hold ghost tags that never resolve, silently failing binding resolution wherever they are referenced.
- **Recommendation:** Add `@Matches(new RegExp(TAG_REF_PATTERN))` to both fqn fields so the boundary rejects malformed FQNs at create/update. Regression spec pins accept-canonical and reject (no device segment, whitespace, double slash, trailing slash) on create, plus reject-on-update while still allowing fqn to be omitted.

### [SENSOR-HIGH-044] Deploying the SCADA package does not gate on unsaved HMI edits, silently shipping the stale server version
- **File:** `web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx`
- **Category:** Deploy safety / false confidence
- **Description:** The SCADA-package deploy dialog's `onDeploy` checked only that a package id exists, not that the in-editor package is saved. Deploy ships the SERVER's persisted package, so an operator with unsaved widget/screen edits (`scadaDirty === true`) would deploy the previously-saved version while believing their current edits went to the device.
- **Impact:** A deploy could push a stale HMI package to a physical device without any indication the on-screen edits were not included.
- **Recommendation:** Gate the SCADA deploy on `scadaDirty` — refuse with a "save first" message until the package is saved. `scadaDirty` is the same pristine signal the hydration guard already trusts, so it is reliable. Regression test asserts a dirty SCADA package blocks deploy (mutation not called).
- **Deferred (tracked):** the equivalent PROCESS-artifact deploy dirty-gate is NOT included here. The process store's `isDirty` is not an accurate unsaved-edits signal in the unified editor — the server load calls `setProcessName` (which marks dirty) and the load effect re-runs when the P&ID iframe becomes ready, so a naive process dirty-gate both mis-fires right after load and races the async reload against edits. Fixing that requires making the process store's dirty tracking accurate (clean-after-load without clobbering concurrent edits), which is a separate change from this gate. Owner: sensor-expert; follow-up finding to be opened when the process dirty-tracking fix is scoped.

### [SENSOR-MEDIUM-021] discoverTags is not concurrent-safe: a plain bulk save 23505-rolls back the whole batch on a duplicate fqn
- **File:** `apps/sensor-service/src/process/services/unified-tag.service.ts`
- **Category:** Concurrency / idempotency
- **Description:** Tag discovery inserted the new tags with a plain `tagRepository.save(newTags)`. Two concurrent discoveries of the same device (or a re-run overlapping a first run) race on the unique `(tenantId, fqn)` index; the loser throws `23505` and TypeORM rolls back the ENTIRE batch, so discovery is neither idempotent nor concurrent-safe.
- **Impact:** Concurrent or overlapping discovery runs could fail wholesale and create no tags, instead of converging on the union.
- **Recommendation:** Insert via an `INSERT ... ON CONFLICT DO NOTHING` (`createQueryBuilder().insert().orIgnore()`), then re-read the full set by fqn so the result reflects rows created here and by any concurrent discovery (and so new rows carry their ids). `createdCount` becomes the re-read delta. Regression spec pins that `orIgnore` is used, only genuinely-new configs are inserted, and the union is returned.

### [SENSOR-HIGH-045] The entire SCADA runtime module is dead code: ScadaRuntimeModule is never imported, so the /scada gateway never mounts
- **File:** `apps/sensor-service/src/app.module.ts`, `apps/sensor-service/src/scada-runtime/scada-runtime.module.ts`
- **Category:** Composition root / feature non-functional
- **Description:** `ScadaRuntimeModule` — the module wiring the `/scada` WebSocket gateway, `TagManagerService`, `AlarmEngineService`, alarm storage, and DAQ storage — was referenced by NOTHING: not `AppModule`, not any feature module. The whole operator control plane (tag subscribe, tag write, alarm acknowledge, value fan-out) never booted in the running sensor-service; operator sockets had nothing to connect to. This is the deepest root under RT-001's "no producer": the consumer side wasn't even mounted.
- **Impact:** Every SCADA runtime feature (including the security fixes hardening it) was dead code at runtime.
- **Recommendation:** Import `ScadaRuntimeModule` in `AppModule`. Boot-safety verified: alarm storage's `onModuleInit` table check is satisfied by migration `1800200000000-CreateScadaAlarmStorage`; the 1 Hz alarm loop is a no-op without configured rules; the scheduler idles; DAQ storage touches its table only on use. A metadata regression test pins the AppModule import so the module cannot silently fall out of the composition root again.

### [SENSOR-HIGH-046] No live-data producer: gateway.pushTagValues has zero production callers, so subscribed operator screens show null forever
- **File:** `apps/sensor-service/src/scada-runtime/services/tag-value-fanout.service.ts` (new), `apps/sensor-service/src/process/services/unified-tag.service.ts`, `apps/sensor-service/src/ingestion/nats-ingestion-consumer.service.ts`, `apps/sensor-service/src/ingestion/ingestion.module.ts`
- **Category:** Realtime correctness / silent no-op (RT-001)
- **Description:** The `/scada` runtime keyed socket subscriptions by canonical TagRef (registry fqn, `deviceCode/localName`), while the ingestion plane keyed every metric by `sensorId/channelId` — and NOTHING bridged the two: `pushTagValues`/`updateTagValues` had no production caller. An operator screen connected, authenticated, subscribed, reported "connected/healthy", and displayed null forever.
- **Impact:** The entire live-data feature was a silent no-op end to end.
- **Recommendation:** A `TagValueFanoutService` producer in the SCADA runtime module: (1) `UnifiedTagService.findFqnsBySensorSource` reverse-resolves `(tenantId, sensorId, channelId)` to registry fqn(s) via the `TagSource.sensorId/channelId` linkage (RETIRED excluded; a channel-less sensor-level tag matches all channels); (2) a 60s-TTL bounded cache (positive AND negative — unmapped sensors cost one query per TTL, not one per reading); (3) `gateway.pushTagValues` for the tenant-fenced fan-out (which also feeds the TagManager last-value cache for late subscribers). Wired into `NatsIngestionConsumerService.handle()` after enqueue (best-effort; never throws — a fan-out failure must not poison JetStream into redelivery), with fan-out counters in the consumer's minute stats. IngestionModule imports ScadaRuntimeModule (no cycle). Quality mapping: IEC 61131-3 subset 0..3 primary, legacy OPC-UA ranges tolerated. Note: values flow once the registry links tags to sensors (`source.sensorId/channelId`) — the registry product path (SP-001) remains the population workstream; legacy MQTT-path fan-out intentionally not wired (ADR-022 moves ingestion to the sidecar).

### [SENSOR-HIGH-047] Unified editor Runtime mode never mounts a live canvas: the center pane is a frozen P&ID iframe that shows no values
- **File:** `web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx`
- **Category:** Realtime correctness / feature non-functional (RT-002)
- **Description:** In Runtime mode the unified editor's center pane was the static P&ID ReactFlow iframe — read-only, fed by nothing (no host ever sent `updateLiveValues`). The live `ScreenCanvas` mounted only in HMI mode and hardcoded the simulation provider, so `StableModeProvider`'s live branch (`mode="preview"` → `LiveDeviceDataProvider` → the tenant-fenced `/scada` socket) was unreachable from the unified editor. The "Live Tags" side panel was a value-less catalog.
- **Impact:** The mode named "Runtime" displayed no runtime data whatsoever.
- **Recommendation:** Mount `<StableModeProvider mode="preview"><ScreenCanvas isPreview/></StableModeProvider>` in Runtime mode — the same read-only live Layer-B chain the operator runtime uses — and hide the P&ID iframe (which stays mounted so its state survives mode switches). With the live producer (SENSOR-HIGH-046) and the mounted control plane (SENSOR-HIGH-045), ingested values now reach the runtime canvas end to end. Regression test pins the live-preview mount and the hidden iframe.

### [SENSOR-HIGH-048] The unified tag registry has no product write path: discover/CRUD hooks exist with zero consumers, so the registry stays empty and every binding resolves unresolved
- **File:** `web/modules/sensor-module/src/pages/tags/TagRegistryPage.tsx` (new), `web/modules/sensor-module/src/Module.tsx`, `web/modules/sensor-module/src/hooks/useUnifiedTags.ts`
- **Category:** Product surface / feature non-functional (SP-001)
- **Description:** `useCreateTag/useUpdateTag/useDeleteTag/useDiscoverTags/useAutoBindTags` and the full GraphQL mutation set were defined but imported by NOTHING — no page or component. With no way to populate `unified_tags`, deploy-time resolution reported every binding unresolved, subscribe-side registry gating had nothing to gate on, and the new live-data fan-out (SENSOR-HIGH-046) had no sensor→fqn linkage to resolve.
- **Impact:** The registry — the tag-identity SSoT of the whole SCADA stack — was unreachable as a product feature.
- **Recommendation:** A Tag Registry page (`/sensor/tags`) binding the existing hooks: device-scoped Discover (idempotent `discoverTags`), searchable paginated browse, an editor for display fields / engineering range / alarm limits, delete-with-confirm — and the LIVE LINK editor that persists `source.sensorId/channelId` (sensor + channel pickers via the `sensors`/`allDataChannels` queries, TanStack Query + tenant-scoped keys), preserving discovery provenance fields on edit. This is the linkage the ingestion fan-out resolves, completing the discover → link → subscribe → live-value chain. Tests pin discover wiring, live-link persistence + provenance survival, link clearing, and delete.

### [SENSOR-HIGH-049] PLC/ST editor "Save" is false-success and Deploy is inert: programs live only in component state and vanish on navigation
- **File:** `web/modules/sensor-module/src/hooks/useStEditor.ts`, `web/modules/sensor-module/src/components/unified-editor/StEditorPanel.tsx`, `web/modules/sensor-module/src/components/deploy/DeployAutomationModal.tsx`, `web/modules/sensor-module/src/graphql/automation.queries.ts`
- **Category:** Data loss / false completion (UI-001, WF-006, UI-004, UI-005)
- **Description:** `useStEditor.save()` was a local-only stub (`// TODO: persist to backend`): the dirty `*` cleared, but the program list lived in component state — switching editor mode or refreshing silently destroyed EVERY ST program while the Save button claimed success. The ST "Deploy (F9)" button rendered with no `onClick` and the F9 shortcut was a TODO. Separately, `DeployAutomationModal` cast the paginated `automationPrograms` CONNECTION (`{items, total, ...}`) to a bare array, so the deployable-program list was permanently empty (UI-005).
- **Impact:** Written PLC logic was unsaveable and undeployable end to end; "Save" lied.
- **Recommendation:** (1) Persistence in the hook: standalone (persist) mode hydrates from the backend AutomationProgram store via a lean `StPrograms` query (ST-type, with source) and `save()` writes through `create/updateAutomationProgram` — the dirty flag clears only on a CONFIRMED write, `isSaving`/`saveError` are the observable outcome, and a `programCode` (≤30, uppercase, unique-suffixed) is derived from the name. (2) Lifecycle: a DEPLOYED program is immutable — save FORKS a new draft program (the backend rejects in-place DEPLOYED edits); APPROVED edits follow the backend's APPROVED→DRAFT reset. (3) Embedded mode (AutomationProgramEditorPage owns persistence) keeps local-only semantics. (4) Deploy: the panel takes `onDeploy`, the button + F9 fire it, and the unified editor opens `DeployAutomationModal`; the modal now reads `connection.items`. Six regression tests cover hydrate/create/update/fork/failure/embedded.

### [SENSOR-HIGH-050] Tag lifecycle is unreachable: nothing can set RETIRED and deleteTag is an unconditional hard delete
- **File:** `apps/sensor-service/src/process/services/unified-tag.service.ts`, `apps/sensor-service/src/process/resolvers/unified-tag.resolver.ts`, `web/modules/sensor-module/src/pages/tags/TagRegistryPage.tsx`, `web/modules/sensor-module/src/hooks/useUnifiedTags.ts`
- **Category:** Lifecycle / data integrity (BE-001, WF-001, WF-002, SP-002)
- **Description:** No DTO or mutation could set a tag's `status`, so the `RETIRED` resolution branch was dead code, and the only removal path was `deleteTag` — an unconditional HARD delete, contradicting the entity's "row stays for audit" contract and able to vanish a tag still referenced by widget bindings (references are FQN strings inside JSONB documents; no FK exists to scan). The FE never even selected `status`.
- **Impact:** A referenced tag could be silently destroyed; the retire lifecycle the schema promised did not exist as a feature.
- **Recommendation:** Server-owned lifecycle methods (mirroring the package-status rule — status is never a client-writable field): a `retireUnifiedTag` mutation (idempotent; bumps `revision` so binding snapshots detect the edit), and `deleteTag` guarded to DRAFT-only — anything past DRAFT can only be retired, which resolution already reports as unresolved, so a referenced tag can never silently vanish (structural, no fragile reference scan). FE: `status` selected in the tag fields, `useRetireTag` hook, and lifecycle-aware Tag Registry actions — DRAFT: edit+delete; ACTIVE: edit+retire; RETIRED: read-only with badge. Five backend + three page tests pin the state machine.

### [SENSOR-HIGH-051] Deploy tag resolution is warn-only on all three device-push paths: packages with unresolvable bindings ship silently
- **File:** `apps/sensor-service/src/process/services/scada-package.service.ts`, `apps/sensor-service/src/process/services/process.service.ts`
- **Category:** Deploy safety (WF-003)
- **Description:** All three deploy boundaries (`deployScadaPackageToEdge`, the bundle artifact path, `deployProcessToEdge`) resolved tag bindings against the registry but only LOGGED unresolved refs — a package whose bindings named unregistered or RETIRED tags still shipped to the device with a warn line as the only trace, making the registry gate advisory theater.
- **Impact:** A deploy could silently push bindings that can never resolve on the device, and retiring a tag did not stop anything from shipping it.
- **Recommendation:** A real gate behind an ops flag: `SCADA_DEPLOY_TAG_GATE=enforce` BLOCKS the deploy with a `BadRequestException` naming each unresolved ref + reason, on all three paths; the default stays `warn` so tenants whose registry is not yet populated (the pre-SP-001 state) keep deploying until ops flips the flag per environment after backfill. Spec pins enforce-blocks (broker untouched), warn-proceeds, and enforce-passes-when-resolved.

### [SENSOR-HIGH-052] The atomic bundle deploy exists backend-side but no UI calls it: the unified editor still ships SCADA + automation as separate fire-and-forget deploys
- **File:** `web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx`, `web/modules/sensor-module/src/hooks/useScadaPackage.ts`, `web/modules/sensor-module/src/graphql/scada-package.queries.ts`
- **Category:** Deploy safety / half-deploy window (GAP-3A)
- **Description:** `deployScadaWithAutomation` — the two-phase atomic bundle path (signed manifest, `release_bundles` PENDING + outbox in one transaction, PUBLISHED only on the edge's confirmation) — was fully implemented backend-side but had zero frontend callers. The unified editor deployed the SCADA package via the single-command fire-and-forget mutation and automation programs separately, reopening the half-deploy window the bundle path was built to close.
- **Impact:** A SCADA package could reach the device without its bound automation programs (or vice versa), with the cloud reporting success.
- **Recommendation:** Route the unified editor's SCADA deploy through a new `useDeployScadaBundle` hook calling `deployScadaWithAutomation` (bundle works with zero programs too — the SCADA artifact is always staged). Success reports "staged — awaiting device confirmation" honestly; failure composes a message naming each failing leg (SCADA and/or per-program). Tests pin the wiring and the failure composition.

### [SENSOR-HIGH-053] DAQ history is a success-shaped stub over a table that does not exist and would not be tenant-safe if it did
- **File:** `apps/sensor-service/src/scada-runtime/scada-runtime.gateway.ts`, `apps/sensor-service/src/scada-runtime/services/daq-storage.service.ts`, `apps/sensor-service/src/database/migrations/1806100000000-CreateScadaTagHistory.ts`, `libs/backend-common/src/database/schema-manager.service.ts`
- **Category:** Realtime correctness / tenant isolation (RT-007)
- **Description:** The gateway's `DAQ_QUERY` handler emitted an empty `DAQ_RESULT` with a `// TODO: Inject DaqService` — historical trends rendered "successfully" blank. Beneath it, `DaqStorageService` queried `scada_tag_history`, a table NO migration ever created — and its schema/queries carried no tenant column, so wiring it naively would have let tenant A read tenant B's history on colliding tag ids. Nothing wrote history either.
- **Impact:** History queries were silent no-ops end to end; the latent design was cross-tenant-unsafe.
- **Recommendation:** (1) Migration creates `sensor.scada_tag_history` with a mandatory `tenant_id` column, composite PK `(tenant_id, tag_id, timestamp)`, and registered in `MODULE_SCHEMAS[sensor].infrastructureTables`. (2) `tenantId` threaded through every `DaqStorageService` method (insert, raw query, aggregated incl. the date_trunc fallback, chunked) — every SQL filter is tenant-fenced. (3) The gateway handler injects `DaqStorageService` and streams real chunked, tenant-fenced results under the client's authenticated tenant. (4) The live fan-out records pushed values into the store best-effort, so what streams live is queryable historically. (5) The script sandbox's history read passes the engine's tenant.

### [SENSOR-LOW-009] PLC mode docks the ST editor to the page bottom, cramping both the canvas and the editor (product request: make it a popup)
- **File:** `web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx`, `web/modules/sensor-module/src/components/unified-editor/StEditorPanel.tsx`
- **Category:** UX / product request
- **Description:** In PLC mode the full ST IDE (toolbar, Monaco, outline, problems) rendered as a resizable bottom dock under the canvas — competing with the P&ID for vertical space and keeping the editor small. Product request: present it as a popup instead of showing it at the bottom of the page.
- **Recommendation:** A `floating` presentation for `StEditorPanel` (fills the host dialog, no dock chrome — resize handle, collapse strip, Ctrl+J are docked-only; persistence semantics unchanged), and PLC mode now opens the editor in a centered modal overlay with a close control that returns to the previous editor mode. Programs persist server-side, so closing loses nothing. Regression test pins popup-open, dock-absence, and close-returns-to-previous-mode.

### [SENSOR-CRITICAL-006 — RESOLUTION] Server-side PIN: save-boundary hashing, read redaction, PIN_VERIFY challenge, gateway enforcement
- **Supersedes:** the OPEN status recorded above for SENSOR-CRITICAL-006.
- **What landed:**
  1. **Save-boundary hardening** (`hardenControlSecurity`, both create and update): every plaintext `widget.config.pin` is stripped, `config.requirePin=true` set, the widget id recorded in `controlPermissions.securityLevels.pin`, and the PIN hashed into the package-level `controlPermissions.pinHash` (salted scrypt, `scrypt$salt$hash`). A raw PIN written into the `pinHash` field is hashed too. Plaintext can never persist through a save.
  2. **Read-path redaction** (`sanitizePackageData`, already covering `pinHash → '[REDACTED]'`): now also strips legacy widget `config.pin` plaintext, replacing it with the `requirePin` trigger — the client keeps prompting but never holds the secret. Roundtrip-safe: the update path restores the stored hash when the incoming doc carries the redaction marker or a null hash.
  3. **Server verification** — `PIN_VERIFY {packageId, pin}` socket message → `verifyPackagePin` (scrypt compare; legacy pre-hardening rows fall back to their stored plaintext values and harden on next save) → `PIN_RESULT {valid, expiresAt|lockedUntil}`. Brute-force limited per socket: 5 consecutive failures lock verification for 60s (short-circuited while locked).
  4. **Gateway enforcement** — a successful verification elevates the SOCKET for 5 minutes; `TAG_WRITE` to any tag bound to a pin-protected widget in ANY of the tenant's non-archived packages (`getPinProtectedTagKeys`, 60s cache) is rejected without elevation. Keyed by TAG, not caller-supplied package context — a direct `socket.emit` cannot opt out.
  5. **Client flow** — `RuntimeInput` no longer compares locally: the PIN dialog calls `ScadaSocketService.verifyPin(packageId, pin)` and proceeds only on the server's verdict, surfacing incorrect-PIN and lockout states.
- **Tests:** pin-hash util roundtrip; create-strips-and-hashes; redacted-roundtrip preserves hash; raw-pinHash hashing; read redaction; verify (hash + legacy + unknown-package fail-closed); protected-set collection (archived skipped); gateway deny-without-elevation / allow-after-verify / lockout short-circuit / unprotected-tags-unaffected.
- **Note:** no bulk data migration is required — legacy rows are redacted at read, keep verifying via the legacy fallback, and harden permanently on their next save.

### [SENSOR-HIGH-054] Process dirty-tracking counts loading as editing and misses real canvas edits — so the "Unsaved" signal lies both ways and the process deploy leg has no dirty gate
- **File:** `web/modules/sensor-module/src/store/processStore.ts`, `web/modules/sensor-module/canvas/main.jsx`, `web/modules/sensor-module/src/types/canvas-messages.ts`, `web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx`, `web/modules/sensor-module/src/pages/process/ProcessEditorPage.tsx`
- **Category:** Workflow / deploy safety (WF-004 — process leg; completes the SCADA-leg gate landed under SENSOR-HIGH-044)
- **Description:** Two inverse defects shared one root cause — the store had no distinction between HYDRATION and USER EDIT. (1) False-dirty: both editor pages hydrated a loaded process through per-field user-edit setters (`setProcessName`, …), so merely OPENING a process showed "Unsaved changes"; the load effect also kept `isCanvasReady` in its deps, re-running hydration mid-session when the iframe handshake landed. The store's clean one-transaction `loadProcess` action existed with ZERO callers. (2) False-clean: real canvas edits (node drag, keyboard delete, palette drop, new connection) never dirtied the store at all — the iframe's `nodesChange`/`edgesChange` echo fires on EVERY state change including host-initiated hydration (`useEffect([nodes])`), so it cannot drive a dirty flag, and nothing else did. On top of both, the process→edge deploy leg had no dirty gate (the SCADA leg got one under SENSOR-HIGH-044), so a stale saved process could ship while newer edits sat unsaved in the canvas.
- **Impact:** Operators could not trust the Unsaved badge in either direction: pristine sessions demanded a save, genuinely edited sessions allowed Save-less navigation and deployed the stale server copy to a device.
- **Recommendation (landed):** Derive dirty from user gestures, not echoes. (1) Store: `loadProcess` retyped to the hydration shape `getProcess` actually returns (`ProcessHydrationInput`; edge `connectionType` defaulted at the boundary), plus `markDirty()` (idempotent by state identity so drag streams cannot re-render subscribers) and `startNewProcess(name)` (a fresh session starts CLEAN — naming it is not an edit). (2) Canvas: wrap ReactFlow's interaction callbacks — which programmatic `setNodes`/`setEdges` never invoke — and emit a new `canvasEdited` message for `position`/`remove` changes (`dimensions`/`select` are mount/click noise); the echo effects stay untouched for state mirroring. (3) Both pages: single-transaction hydration via `loadProcess` with `isCanvasReady` demoted to a ref (the 'ready' replay covers ready-after-load), `canvasEdited`/`nodeAdded`/`edgeAdded` → `markDirty()` (unified page: `mode==='pid'` ref guard; scadaWidget drops excluded — they belong to the SCADA store), host-side delete marks dirty (programmatic removal never echoes an interaction callback), and the template branch seeds then deliberately marks dirty (seeded content IS unsaved work). (4) Deploy gate: the process leg now refuses to deploy while `isDirty`, mirroring the SCADA leg's SENSOR-HIGH-044 gate, on both the unified and legacy pages. Tests: store spec (load-clean, markDirty identity-idempotence, startNewProcess-clean, rename-still-dirties); page specs pin load-leaves-clean (Save disabled, no badge), canvasEdited-enables-Save, the non-P&ID mode guard, and the dirty-process deploy block; the dual-target save spec now asserts Save is DISABLED after load and re-enables on a real edit.

### [SENSOR-HIGH-055] Cloud↔edge widget-type parity gap: the builder ships ~53 widget types into a Rust enum of 16 with no tolerance — one unfamiliar widget makes the whole package undeployable on the device while the cloud reports success
- **File:** `libs/sensor-contracts/src/scada-package-doc/{edge-widget-support,edge-deploy-transform,edge-scada-package-doc.schema}.ts` (new), `libs/sensor-contracts/src/schemas/deploy-scada-package.schema.ts`, `apps/sensor-service/src/process/services/scada-package.service.ts`, `sens-api-gateway/src/scada_types.rs`, `sens-api-gateway/src/commands/system.rs`, `libs/sensor-contracts/fixtures/`, `tools/scripts/check-sensor-contract-parity.ts`
- **Category:** Contract parity / deploy safety (CONTRACT-H-002)
- **Description:** The builder's `ScadaWidgetType` union has ~53 members; the Rust edge `WidgetType` enum has 16 variants and NO `#[serde(other)]` — a single widget of any other type failed the entire package deserialization on the device, after the cloud had validated (against the open DocV2 save schema, whose `widgetType` is a free string), signed, published, and flipped the row PUBLISHED. The parity fixtures only exercised edge-supported types, so the cross-language gate could not catch it. Deploys of real builder content (staticText labels, SVG shapes, VFD panels, equipment symbols) were silently broken end to end.
- **Impact:** Any non-trivial HMI built with the full palette could not actually reach a device, and the failure surfaced nowhere in the cloud.
- **Recommendation (landed):** Three-layer root fix. (1) **Contracts SSoT** — `EDGE_SUPPORTED_WIDGET_TYPES` (16, the camelCase mirror of the Rust enum), `EDGE_REJECTED_WIDGET_TYPES` (7 control-semantics types whose silent removal would change what the operator can actuate: knob, dropdownSelect, scheduler, vfdDrive, vfdMini, vfdGroup, equipment), `classifyWidgetTypeForEdge` (unknown → strip), and the PURE `transformScadaDocForEdgeDeploy` (upcaster discipline): collects ALL rejects (not first-fail), strips decorative/display-only widgets, and normalizes what the Rust structs require but the open save contract does not (screen name/screenType into the closed 6-set, alarm severity into the closed 4-set, alarm message synthesized as `"<tag> <condition> <value>"`). A strict `EDGE_SCADA_PACKAGE_DOC_SCHEMA` recomposes into `DEPLOY_SCADA_PACKAGE_PARAMS_SCHEMA`, mechanically hardening the existing publish validation; DocV2 (the save/editor contract) stays open. (2) **Publish boundary** — both deploy paths (single-command + bundle) transform AFTER upcast and BEFORE the tag gate; rejects throw a `BadRequestException` naming every violating widget; strips are warn-logged, excluded from the artifact/signature/payload, and named in the success message. Rollback deliberately does NOT transform (byte-fidelity to the signed artifact). (3) **Edge tolerance** — `#[serde(other)] Unknown` on `WidgetType` and `ScreenType`; the deploy handler counts unknown widgets, warns with their ids, reports `unknown_widget_count` in the ack, and never fails the package — absorbing pre-transform artifacts on rollback and newer-cloud/older-firmware skews. **Pins:** the deploy fixture now exercises all 16 supported types (TS asserts the exact set, Rust asserts none deserializes to Unknown — together `EDGE_SUPPORTED ⊆ Rust enum`); a new unsupported-widget fixture is asymmetric by design (raw FAILS the strict TS schema, still PARSES in Rust via Unknown); the FE invariant spec's `Record<ScadaWidgetType, …>` partition makes adding a builder widget type without deciding its edge fate a compile error.
