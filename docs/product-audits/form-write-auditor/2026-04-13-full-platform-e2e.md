# Form Write Auditor: `2026-04-13-full-platform-e2e`

Scope checked: `web/**`, `web/apps/aquamobil/**`, and the corresponding `apps/**`, `libs/**`, `platform/**`, and `database/**` surfaces needed to trace create/edit/update/delete write paths end to end.

Prior cycle: `docs/test-audits/form-write-auditor/2026-04-11-full-platform-e2e.md` (4 findings). Commit `79ce984f` was cited as closing 12 findings from the broader e2e audit, but none of the 4 form-write-auditor findings (HIGH-001 through MEDIUM-004) were resolved. All four are re-reported below with ESCALATION markers.

---

## Findings

### HIGH-001: [REPEAT/ESCALATED] AquaMobil leave submission writes server state but does not invalidate the visible read model

**Prior cycle:** 2026-04-11 HIGH-001. **Status:** OPEN -- not fixed by commit 79ce984f.

`LeaveRequestPage.tsx` at line 81 calls `addToQueue('createLeaveRequest', ...)` and at line 95 calls `submitRequest(queueId)`. The `useSubmitLeaveRequest()` hook at `/var/aqua-saas/web/apps/aquamobil/src/hooks/useLeave.ts#L187-L203` fires a raw `graphqlRequest(SUBMIT_LEAVE_REQUEST, { id })` without calling `queryClient.invalidateQueries()` for the `leaveRequests` or `leaveBalances` query keys. There is no `invalidateQueries` call anywhere in `useLeave.ts` (confirmed via grep: zero matches).

Consequence: after a successful leave submission, the user navigates to `/leave` where `useMyLeaveRequests()` (line 110) and `useMyLeaveBalances()` (line 65) serve stale React Query cache. The newly created request is invisible until `staleTime` (2 min / 5 min respectively) expires or the user manually pulls to refresh.

Root cause: the mutation path (manual `useState`/`useCallback` pattern at line 187) bypasses React Query's mutation lifecycle. The comment at line 183-185 explicitly acknowledges this as a follow-up.

Cross-domain: `mobile-app-auditor`, `data-readback-auditor`, `workflow-state-auditor`.

---

### HIGH-002: [REPEAT/ESCALATED] AquaMobil message delete is exposed in the UI but the handler is a no-op

**Prior cycle:** 2026-04-11 HIGH-002. **Status:** OPEN -- not fixed.

`ChatRoomPage.tsx` at `/var/aqua-saas/web/apps/aquamobil/src/pages/messaging/ChatRoomPage.tsx#L159-L164`:

```typescript
const handleDelete = useCallback(async (messageId: string) => {
  // TODO: wire to deleteMessage GraphQL mutation
  // For now this is a placeholder -- the actual mutation should be
  // called via a dedicated hook (useDeleteMessage).
}, []);
```

This empty callback is passed as `onDelete={isOwn ? handleDelete : undefined}` at line 368. The GraphQL mutation `deleteMessage` exists in the offline queue at `/var/aqua-saas/web/apps/aquamobil/src/hooks/useOfflineQueue.tsx#L178-L182` and in the operations file at `/var/aqua-saas/web/apps/aquamobil/src/graphql/messaging-operations.ts#L308`. The plumbing is complete -- only the handler body is missing.

The user taps "Delete", the context menu closes, the message remains. False success with no error feedback.

Cross-domain: `button-action-auditor`, `mobile-app-auditor`.

---

### HIGH-003: [REPEAT/ESCALATED] Channel edit button is rendered but has no onClick, no modal, and no mutation wiring

**Prior cycle:** 2026-04-11 HIGH-003. **Status:** OPEN -- not fixed.

`ChannelSettingsPage.tsx` at `/var/aqua-saas/web/apps/aquamobil/src/pages/messaging/ChannelSettingsPage.tsx#L239-L242`:

```tsx
{canEdit && channel.type === 'group' && (
  <button className="p-1 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 touch-feedback">
    <Edit3 size={14} className="text-gray-400" />
  </button>
)}
```

No `onClick`, no form, no modal. The `UPDATE_CHANNEL` mutation exists at `/var/aqua-saas/web/apps/aquamobil/src/graphql/messaging-operations.ts#L233-L239`, and `useChannelActions` at `/var/aqua-saas/web/apps/aquamobil/src/hooks/useChannelActions.ts` only exposes `updateNotificationPref`, `leaveChannel`, and `archiveChannel` -- no `updateChannel` function.

Cross-domain: `contract-parity-auditor`, `button-action-auditor`.

---

### HIGH-004: AquaMobil "Add Member" button on ChannelSettingsPage is inert -- no onClick handler

`ChannelSettingsPage.tsx` at `/var/aqua-saas/web/apps/aquamobil/src/pages/messaging/ChannelSettingsPage.tsx#L355-L358`:

```tsx
<button className="flex items-center gap-1 text-xs text-ocean-500 font-medium touch-feedback">
  <UserPlus size={14} />
  Add
</button>
```

This button renders for `canEdit` users (admin/owner) on group channels. It has no `onClick` handler. The GraphQL operation `ADD_CHANNEL_MEMBER` exists at `/var/aqua-saas/web/apps/aquamobil/src/graphql/messaging-operations.ts#L248`, but nothing in the page or `useChannelActions` hook invokes it.

Users see a clickable "Add" affordance next to the member list header. Tapping it does nothing -- no modal, no navigation, no feedback. This is a false affordance that advertises member-add capability without any write path.

Cross-domain: `button-action-auditor`, `contract-parity-auditor`.

---

### HIGH-005: ChatRoomPage attachment and voice recording handlers are empty TODO stubs

`ChatRoomPage.tsx` at `/var/aqua-saas/web/apps/aquamobil/src/pages/messaging/ChatRoomPage.tsx#L392-L397`:

```tsx
onAttachmentPress={() => {
  // TODO: open native file picker or attachment sheet
}}
onVoiceRecordingComplete={(blob, durationSeconds, mimeType) => {
  // TODO: upload voice recording and send as voice message
}}
```

The `MessageInput` component renders a paper-clip icon (attachment) and a microphone button (voice recording). Tapping attachment does nothing. Completing a voice recording invokes the callback which silently discards the recorded blob. Both are user-visible write affordances that perform no write.

The `useSendMessage` hook at `/var/aqua-saas/web/apps/aquamobil/src/hooks/useSendMessage.ts` already supports `attachmentKeys` and `contentType: 'voice'` in its `SendMessageParams` interface (line 35-40), but neither is wired from the page.

Cross-domain: `button-action-auditor`, `mobile-app-auditor`.

---

### MEDIUM-006: [REPEAT/ESCALATED] Admin AI persona configuration is presentation-only and does not persist

**Prior cycle:** 2026-04-11 MEDIUM-004. **Status:** OPEN -- not fixed.

`MessagingAiPersonasPage.tsx` at `/var/aqua-saas/web/modules/admin-panel/src/pages/messaging/MessagingAiPersonasPage.tsx#L189-L196`:

```typescript
const handleToggle = useCallback((personaId: string | null) => {
  setPersonas((prev) =>
    prev.map((p) =>
      p.id === personaId ? { ...p, enabledForAll: !p.enabledForAll } : p,
    ),
  );
  // TODO: Persist toggle via admin API mutation
}, []);
```

The toggle modifies React component state only. On page refresh, all personas revert to `DEFAULT_PERSONAS`. The "Add Custom Persona" button at line 211 toggles `showAddForm` local state but the form card below it (lines 220+) is a "Coming Soon" placeholder.

On the backend, `AiPersonasRegistryService` at `/var/aqua-saas/apps/messaging-service/src/ai/services/ai-personas-registry.service.ts#L107-L115` always returns the hardcoded `DEFAULT_PERSONAS` array. The `getPersonasForTenant()` method ignores any per-tenant overrides.

Cross-domain: `schema-surface-parity-auditor`, `data-readback-auditor`.

---

### MEDIUM-007: Employee edit form silently drops key fields that are editable on create but locked on edit

`EmployeeFormPage.tsx` at `/var/aqua-saas/web/modules/hr-module/src/pages/EmployeeFormPage.tsx`.

When editing, the `UpdateEmployeeInput` constructed at lines 207-218 includes only: `firstName`, `lastName`, `contactInfo`, `address`, `position`, `currency`, `personnelCategory`, `seaWorthy`. It intentionally excludes `departmentHrId`, `department`, `hireDate`, `employmentType`, and `baseSalary` (all disabled in the UI via `disabled={isEditing}`).

However, `employmentType` at line 636-648 is NOT disabled -- it renders a fully interactive `<select>` without the `disabled` prop. A user can change employment type from `FULL_TIME` to `CONTRACT` in the edit form, but the `UpdateEmployeeInput` at lines 207-218 never sends `employmentType` to the backend. The selection is silently dropped on save.

Root cause: the `employmentType` select at line 636 lacks `disabled={isEditing}`, unlike every other locked field (`email`, `dateOfBirth`, `nationalId`, `departmentHrId`, `position`, `hireDate`). Either the field should be locked (add `disabled`), or it should be included in `UpdateEmployeeInput`.

Cross-domain: `contract-parity-auditor`.

---

### MEDIUM-008: WaterQualityRecordPage bypasses the offline queue for direct GraphQL mutation -- no offline write path

`WaterQualityRecordPage.tsx` at `/var/aqua-saas/web/apps/aquamobil/src/pages/water-quality/WaterQualityRecordPage.tsx#L199-L207` uses `useMutation` with `graphqlRequest` directly for the `createWaterQualityMeasurement` mutation. Unlike every other AquaMobil write form (feeding, harvest, mortality, cull, transfer, stock movement) which route through `addToQueue()` for offline-first writes, this page calls the GraphQL endpoint directly.

The offline indicator at line 344 says "Measurements will be synced when connected", but this is misleading: there is no offline queueing. If the worker is offline, the mutation will throw a network error. The `createWaterQuality` operation type IS defined in the offline queue at `/var/aqua-saas/web/apps/aquamobil/src/hooks/useOfflineQueue.tsx#L131-L139`, but `WaterQualityRecordPage` never calls it.

This is the only mobile form that cannot work offline, breaking the platform's offline-first promise for remote cage/pen sites.

Cross-domain: `mobile-app-auditor`.

---

### MEDIUM-009: Harvest form sends `totalBiomass` as a client-computed derived value -- server should be authoritative

`RecordHarvestPage.tsx` at `/var/aqua-saas/web/apps/aquamobil/src/pages/harvest/RecordHarvestPage.tsx#L89-L100`:

```typescript
await addToQueue('createHarvestRecord', {
  batchId: metrics.batchId,
  tankId: selectedTankId,
  quantityHarvested: quantityNum,
  averageWeight: avgWeightNum,
  totalBiomass,                    // <-- client-computed: (quantityNum * avgWeightNum) / 1000
  ...
});
```

`totalBiomass` is computed at line 51 as `(quantityNum * avgWeightNum) / 1000`. This derived value is trusted from the client. If a tampered mobile client sends `totalBiomass: 0` while sending `quantityHarvested: 10000` and `averageWeight: 500`, the backend would persist a zero biomass for a 5000 kg harvest.

The server should derive `totalBiomass` from `quantityHarvested * averageWeight / 1000` rather than trusting the client value.

Cross-domain: `contract-parity-auditor`, `tenant-isolation-auditor`.

---

### MEDIUM-010: TransferModal sends `avgWeightG` from the `tank` prop but the read-only UI field shows a different local state variable

`TransferModal.tsx` at `/var/aqua-saas/web/modules/farm-module/src/pages/production/components/TransferModal.tsx`. The component maintains a `[avgWeightG, setAvgWeightG]` state at line 38, initialized from `tank.avgWeightG`. At line 146, the submitted value is `avgWeightG: tank.avgWeightG > 0 ? tank.avgWeightG : undefined` -- reading directly from the `tank` prop, NOT from the `avgWeightG` state.

Meanwhile, the biomass calculation at line 64 uses `sourceAvgWeightG` (also from `tank.avgWeightG`), but the UI display at line 319 reads `tank.avgWeightG?.toFixed(1)` and the field is read-only/disabled. The `avgWeightG` state variable at line 38 is initialized but never read or submitted. This is dead state that creates confusion but currently causes no data loss because the prop is used consistently.

However, a previous `setAvgWeightG` was available for user editing, meaning this field may have been editable before and was locked without cleanup. The dead state variable should be removed to prevent future accidental re-introduction.

---

### LOW-011: CullModal (web) and RecordCullPage (mobile) send `culledAt` in different formats

**Web (CullModal.tsx):** Line 28 sends `culledAt` as `new Date().toISOString().split('T')[0]` (date-only string, e.g., `"2026-04-13"`).

**Mobile (RecordCullPage.tsx):** Line 83 sends `culledAt: new Date().toISOString()` (full ISO datetime, e.g., `"2026-04-13T10:30:00.000Z"`).

The backend `RecordCullInput` must accept both or normalize. If the backend expects a date-only string and the mobile sends a full ISO datetime, the cull date may be interpreted as the previous day in UTC-offset timezones (e.g., `2026-04-12T22:00:00.000Z` for a 2026-04-13 cull in UTC+2). Similarly, mortality differs: `MortalityModal` sends `observedAt` as date-only (line 29); `RecordMortalityPage` sends `observedAt: new Date().toISOString()` as full datetime (line 92).

Cross-domain: `contract-parity-auditor`.

---

### LOW-012: SiteFormModal passes `Partial<SiteFormData>` to `onSave` but always sends the full form object

`SiteFormModal.tsx` at `/var/aqua-saas/web/modules/farm-module/src/pages/setup/components/SiteFormModal.tsx#L31`:

```typescript
onSave: (data: Partial<SiteFormData>) => void;
```

The `handleSubmit` at line 177-180 calls `onSave(formData)` with the full `formData` object (not a partial). The `Partial` typing is incorrect -- it signals to the parent consumer that fields may be `undefined`, which can lead to defensive checks or accidental null writes that are never actually needed since all fields are always present (initialized to empty strings/numbers at lines 84-106).

---

### LOW-013: StockTransferPage omits idempotencyKey -- no protection against duplicate submissions on network retry

`StockTransferPage.tsx` at `/var/aqua-saas/web/apps/aquamobil/src/pages/storage/StockTransferPage.tsx#L201-L207`:

```typescript
const input: StockTransferInput = {
  itemType: selectedItemType!,
  itemId: selectedItemId,
  fromLocationId,
  toLocationId,
  quantity: parseFloat(quantity),
};
```

Compare with `StockMovementPage.tsx` at line 296 which includes `idempotencyKey: crypto.randomUUID()`. The transfer page lacks this field, so if the same request is retried (network timeout + offline queue fallback at lines 223-228), the backend may create duplicate transfer records.

Cross-domain: `contract-parity-auditor`.

---

## Summary

| Severity | Count | New | Repeat |
|----------|-------|-----|--------|
| HIGH     | 5     | 2   | 3      |
| MEDIUM   | 4     | 4   | 0      |
| LOW      | 3     | 3   | 0      |

**Repeat findings (3):** HIGH-001, HIGH-002, HIGH-003 from the 2026-04-11 cycle remain OPEN. They were not addressed by commit 79ce984f. MEDIUM-004 is re-reported as MEDIUM-006.

**Highest risk:** HIGH-001 (leave submission invisible after save), HIGH-002 (message delete no-op), HIGH-005 (attachment/voice recording silently discarded). These are user-initiated write actions that appear to succeed but produce no persisted result.

**Architectural root cause pattern:** The messaging module's mobile write paths (delete, edit channel, add member, attachment upload, voice send) all have backend contracts defined in `messaging-operations.ts` and offline-queue mutation strings in `useOfflineQueue.tsx`, but the page-level handlers that connect UI actions to these contracts are either empty TODOs or missing entirely. This is a systematic wiring gap rather than individual oversights.

**Offline-first consistency gap:** Water quality recording is the sole AquaMobil form that calls GraphQL directly instead of routing through the offline queue, breaking the platform's offline-first guarantee for remote site workers.
