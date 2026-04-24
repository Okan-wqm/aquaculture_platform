# Scope C — Phase 3 Tier 2/3 + Sub-Equipment CRUD + Admin-Only Frontend UI (2026-04-24)

## 0. Key findings from investigation

Before the plan, the following facts from the codebase **invalidate several assumptions** in the original brief and drive the plan shape:

1. **Stack is not Apollo + RHF + zod.** Farm-module uses `@tanstack/react-query` + `graphql-request` directly. `zod`, `react-hook-form`, and `@apollo/client` are **not** dependencies of `web/modules/farm-module/package.json`, `web/shared-ui/package.json`, or the root `package.json`. Canonical Tier 1 files (`CloseBatchModal.tsx`, `UpdateBatchStatusModal.tsx`, `SubEquipmentModal.tsx`) use `useState` + a `useMemo`-derived `errors: string[]` array + `useMutation`. **The plan must follow that pattern** — introducing RHF/zod mid-stream would fork the convention.
2. **E2E is Playwright, not Cypress.** `/var/aqua-saas/e2e/playwright.config.ts`, tests in `e2e/tests/modules/farm/`. Existing farm e2e (`batch-status-transitions.spec.ts`) is **API-driven** via GraphQL helpers in `test-helpers.ts`, not UI-driven. Tier 2 e2e should follow that model.
3. **Tier 1 modals exist but are not wired into any page.** `grep -rln CloseBatchModal` returns only the file itself. `UpdateBatchStatusModal`, `AllocateBatchToTankModal`, and `AssignFeedsToBatchModal` are also orphaned. Only `BatchFormModal` (pre-existing) and `SubEquipmentModal` (dual create/edit, already used in SetupPage) are referenced. This is a latent gap — the Tier 2 plan must treat "wire up Tier 1 modals" as shared prework, since the new row actions will live next to Tier 1 actions on the same pages.
4. **Batch detail route does not exist.** `BatchInputTab.tsx:218` navigates to `/sites/batch/${batch.id}`, but no such `Route` exists in `Module.tsx`. The brief's suggestion of a "Batch detail page" is also aspirational. We must **create a real batch detail page** as part of Tier 2 groundwork.
5. **Backend hooks already exist for some Tier 2/3 mutations.** `useUpdateBatchFeedAssignment`, `useDeleteBatchFeedAssignment`, `useUpdateSubEquipment`, and `useDeleteSubEquipment` are already implemented in hooks files. Only the **UI surface** is missing. `useCompleteWorkOrder` exists but targets `completeWorkOrder` (different backend mutation from Tier 2 #5 `completeMaintenance`). Missing hooks: `useUpdateBatch`, `useCompleteMaintenance`, `useGenerateWorkOrderFromSchedule`, `useProcessAutoGenerateWorkOrders`, `useUpdateMeterReading`, `useCreateBatchWaterQualityMeasurements`, `useUpdateSentinelHubInstanceId`.
6. **GraphQL operations live inline in hook files**, not in `graphql/<feature>.operations.ts`. The `graphql/` directory has a small set of older files (`feeding.operations.ts`, etc.); new hooks add the query string as a `const X_MUTATION = \`…\`` inside the hook file. Follow the inline convention.
7. **Codegen produces only types**, not hooks. `codegen.ts` generates `web/shared-ui/src/generated/graphql-types.ts` via the `typescript` plugin with `skipTypename: true`. We can leverage generated types but must continue to write hooks by hand.
8. **Role gating is available but not used in the farm module today.** `useAuth()` from `@aquaculture/shared-ui` exposes `hasRole`, `hasAnyRole`, `hasPermission`, and `hasRoleOrHigher`. Zero current usages inside `web/modules/farm-module/src`. The permission-matrix file (`apps/farm-service/src/common/authz/permission-matrix.ts`) lists required roles per mutation; we must mirror those on the client. **No `can<Mutation>` GraphQL query pattern exists.** The client will compute gating itself from the user role + a static mirror table.
9. **A shared `DeleteConfirmationDialog` already exists** at `web/shared-ui/src/components/Modal/DeleteConfirmationDialog.tsx` with a rich cascade-preview payload shape (`DeletePreviewData`). Not every delete in this phase needs the cascade preview — simple deletes (feed assignment, sub-equipment when no preview endpoint exists) can bypass it with a lightweight `ConfirmDialog`. We introduce a minimal `ConfirmDialog` instead of forcing everything through the cascade dialog.
10. **Backend mutation signatures confirmed** from `apps/farm-service/src/maintenance/resolvers/maintenance-schedule.resolver.ts`, `apps/farm-service/src/batch/resolvers/batch.resolver.ts`, `apps/farm-service/src/water-quality/water-quality.resolver.ts`, and `apps/farm-service/src/sentinel-hub/sentinel-hub.resolver.ts`. Inputs are `CompleteMaintenanceInput`, `UpdateMeterReadingInput`, `UpdateBatchInput`, `CreateBatchWaterQualityInput`. `generateWorkOrderFromSchedule` takes a bare `scheduleId: ID!`, `processAutoGenerateWorkOrders` takes no args, `updateSentinelHubInstanceId` takes a bare `instanceId: String!`.

---

## 1. Investigation tasks (pre-implementation checklist)

Every engineer picking up any phase below **must** verify before writing code. Evidence targets listed per item.

| # | Task | Command / path | Expected evidence |
|---|---|---|---|
| I-1 | Confirm Tier 1 canonical pattern | `web/modules/farm-module/src/pages/production/components/CloseBatchModal.tsx` | `useState` + `useMemo(errors)` + `useMutation` + `{ Modal, Button, useToast } from '@aquaculture/shared-ui'`. No RHF. No zod. |
| I-2 | Confirm Tier 1 orphaned | `grep -rln CloseBatchModal web/modules/farm-module/src` | Only the component file itself — **no importer** in any tab/page. Same for UpdateBatchStatusModal, AllocateBatchToTankModal, AssignFeedsToBatchModal. |
| I-3 | Confirm stack | `web/modules/farm-module/package.json`, `web/shared-ui/package.json` | `@tanstack/react-query` present; no `react-hook-form`, `zod`, or `@apollo/client`. |
| I-4 | Confirm GraphQL transport | `web/shared-ui/src/utils/graphql-utils.ts` or `index.ts` | `graphqlClient.request(query, vars)` is re-exported. Used throughout hooks. |
| I-5 | Confirm codegen scope | `codegen.ts` | Only generates `web/shared-ui/src/generated/graphql-types.ts` with `typescript` plugin (types, no hooks). |
| I-6 | Confirm Modal/Button/Toast exports | `web/shared-ui/src/index.ts` | `Modal`, `Button`, `DeleteConfirmationDialog`, `Input`, `Select`, `useToast` are exported. |
| I-7 | Confirm DeleteConfirmationDialog signature | `web/shared-ui/src/components/Modal/DeleteConfirmationDialog.tsx` | Requires `preview: DeletePreviewData` — heavy for simple deletes. |
| I-8 | Confirm auth helpers | `web/shared-ui/src/hooks/useAuth.ts` | `hasRole`, `hasAnyRole`, `hasPermission`, `hasRoleOrHigher` exported. |
| I-9 | Confirm role matrix for each Tier 2/3 mutation | `apps/farm-service/src/common/authz/permission-matrix.ts` | Already captured: see §4 per-mutation table. |
| I-10 | Confirm existing hooks vs. gaps | `grep -n "^export function" web/modules/farm-module/src/hooks/use{Batches,BatchFeedAssignments,Maintenance,WaterQuality,SubEquipment,SentinelHub}.ts` | Hooks present/missing table matches §4. |
| I-11 | Confirm no Apollo / no Cypress | `find /var/aqua-saas -maxdepth 4 -name "cypress*"`; `grep -rn "@apollo/client" web/` | Nothing. Playwright is at `/var/aqua-saas/e2e/`. |
| I-12 | Confirm batch detail route missing | `grep -n "batch/:" web/modules/farm-module/src/Module.tsx` | No route. `BatchInputTab:218` is a dead navigate. |
| I-13 | Confirm error-code shape from backend | `grep -n "BATCH_WITHDRAWAL_BLOCKED\|extensions" apps/farm-service/src/common/filters/*` | `AllExceptionsFilter` emits `extensions.code`. `CloseBatchModal.parseWithdrawalBlock` is the reference implementation. |

---

## 2. Shared infrastructure (PR 0 — lands first)

These utilities must land **before** per-mutation PRs. One self-contained PR.

### 2.1 `ConfirmDialog` (lightweight)

- **Path (new):** `web/shared-ui/src/components/Modal/ConfirmDialog.tsx`
- **Why:** `DeleteConfirmationDialog` requires a `DeletePreviewData` payload and a cascade query. Our Tier 2/3 deletes (feed assignment, sub-equipment when not cascading, auto-generate confirmation, etc.) do not have a cascade preview endpoint, so they need a smaller primitive. This also prevents copy-pasting `Modal`+two-button patterns in 4 new modals.
- **Signature:**
  ```ts
  interface ConfirmDialogProps {
    isOpen: boolean;
    onClose: () => void;
    onConfirm: () => void;
    title: string;
    message: React.ReactNode;        // e.g. "Yem ataması silinsin mi?"
    confirmLabel?: string;           // default "Sil"
    cancelLabel?: string;            // default "İptal"
    variant?: 'danger' | 'warning' | 'primary';
    isPending?: boolean;             // disables + shows spinner
    requireTypedConfirmation?: string; // optional — user must type this string
  }
  ```
- **Export:** `web/shared-ui/src/components/Modal/index.ts` and re-export from `web/shared-ui/src/index.ts`.
- **Test:** `web/shared-ui/src/components/Modal/__tests__/ConfirmDialog.test.tsx` — covers click handlers, disabled-while-pending, typed-confirmation gate.

### 2.2 `usePermissionMatrix` hook + static matrix mirror

- **Path (new):** `web/shared-ui/src/authz/permission-matrix.ts` and `web/shared-ui/src/authz/usePermission.ts`
- **Why:** The backend matrix at `apps/farm-service/src/common/authz/permission-matrix.ts` is not currently exposed to the frontend. Rather than adding a new GraphQL query (extra round-trip, extra resolver to keep in sync), mirror the subset of mutations the frontend gates on, enforced by a unit test that reads the backend source and diffs. This satisfies the "NO patches, architectural" standing rule.
- **Shape:**
  ```ts
  // permission-matrix.ts
  export const FRONTEND_MUTATION_ROLES: Record<string, UserRole[]> = {
    updateBatch: ['MODULE_MANAGER', 'MODULE_USER', 'TENANT_ADMIN'],
    updateBatchFeedAssignment: ['MODULE_MANAGER', 'TENANT_ADMIN'],
    deleteBatchFeedAssignment: ['TENANT_ADMIN'],
    generateWorkOrderFromSchedule: ['MODULE_MANAGER', 'TENANT_ADMIN'],
    completeMaintenance: ['MODULE_MANAGER', 'MODULE_USER', 'TENANT_ADMIN'],
    createBatchWaterQualityMeasurements: ['MODULE_MANAGER', 'MODULE_USER', 'TENANT_ADMIN'],
    processAutoGenerateWorkOrders: ['TENANT_ADMIN'],
    updateMeterReading: ['MODULE_MANAGER', 'MODULE_USER', 'TENANT_ADMIN'],
    updateSubEquipment: ['MODULE_MANAGER', 'TENANT_ADMIN'],
    deleteSubEquipment: ['MODULE_MANAGER', 'TENANT_ADMIN'],
    updateSentinelHubInstanceId: ['TENANT_ADMIN'],
  };
  // usePermission.ts
  export function useCanMutate(mutationName: keyof typeof FRONTEND_MUTATION_ROLES): boolean;
  ```
- **Enforcement test:** `web/shared-ui/src/authz/__tests__/permission-matrix.parity.test.ts` parses `apps/farm-service/src/common/authz/permission-matrix.ts` at test time (read as string, regex-extract) and fails if any key in `FRONTEND_MUTATION_ROLES` disagrees with backend. Closes **FE-HIGH-001** (see §5).

### 2.3 `useErrorCodeMap` — error-code to i18n fallback

- **Path (new):** `web/shared-ui/src/hooks/useErrorMessage.ts`
- **Why:** `CloseBatchModal` already hand-rolls `parseWithdrawalBlock`. That logic belongs in one place. Backend uses `extensions.code`; we surface a map from code → user-facing Turkish string with a raw-message fallback.
- **Shape:**
  ```ts
  export interface ParsedGraphQLError {
    code?: string;                // e.g. BATCH_WITHDRAWAL_BLOCKED
    message: string;              // localized or raw
    extensions?: Record<string, unknown>;
  }
  export function parseGraphQLError(err: unknown): ParsedGraphQLError;
  export function formatErrorForToast(err: unknown): string;
  ```
- **Initial code map** (hand-curated, grows per-phase): seed with `BATCH_WITHDRAWAL_BLOCKED`, `FEED_ASSIGNMENT_IN_USE`, `METER_READING_NOT_INCREASING`, `AUTO_GENERATE_THROTTLED`, plus a generic fallback.
- **Test:** `__tests__/useErrorMessage.test.ts` — one case per code, one fallback case.

### 2.4 Batch detail route + page skeleton

- **Path (new):** `web/modules/farm-module/src/pages/production/BatchDetailPage.tsx` and `web/modules/farm-module/src/pages/production/tabs/BatchOverviewTab.tsx`
- **Why:** Tier 2 #1/#2/#3 all require "Batch detail page". The dead `navigate('/sites/batch/:id')` at `BatchInputTab.tsx:218` proves this was always planned but never built. Rather than fabricate UI on the list row, we build the real page, wire the 4 orphaned Tier 1 modals (`CloseBatchModal`, `UpdateBatchStatusModal`, `AllocateBatchToTankModal`, `AssignFeedsToBatchModal`) and the new Tier 2 actions into it.
- **Structure:** three tabs — `Overview` (batch metadata + status/close actions), `Tanks` (allocations), `Feeding` (feed assignments, where Tier 2 #2/#3 UI lives).
- **Route addition:** `Module.tsx` — `<Route path="batch/:batchId/*" element={<BatchDetailPage />} />`.
- **Closes FE-MEDIUM-001** (orphan Tier 1 modals) and **FE-HIGH-002** (dead navigate).

**PR-0 scope:** all 4 items above, ~600-800 LOC net (mostly the BatchDetail skeleton). No mutation behavior change.

---

## 3. Sequencing

```
PR-0  Shared infrastructure (§2)         ── blocks everything
  │
  ├─ PR-1  Wire up orphan Tier 1 modals   (cleanup; safe; independent tests)
  │
  ├─ PR-2  Phase 2.1  updateBatch         (Tier 2 #1 — simplest Tier 2)
  ├─ PR-3  Phase 2.2  Feed assignment edit + delete (Tier 2 #2, #3)
  ├─ PR-4  Phase 2.3  generateWorkOrderFromSchedule (Tier 2 #4)
  ├─ PR-5  Phase 2.4  completeMaintenance (Tier 2 #5)  ← depends on PR-4 (same page)
  │
  ├─ PR-6  Phase 3.1  Bulk WQ grid        (Tier 3 #6 — largest)
  ├─ PR-7  Phase 3.2  processAutoGenerateWorkOrders (Tier 3 #7, admin)
  ├─ PR-8  Phase 3.3  updateMeterReading  (Tier 3 #8)  ← depends on PR-4 (pre-checks share the schedule detail view)
  │
  ├─ PR-9  Phase 4.1  deleteSubEquipment  (Sub-eq CRUD — updateSubEquipment already shipped)
  │
  └─ PR-10 Phase 5.1  updateSentinelHubInstanceId (admin-only)
```

**Dependencies:**
- **PR-0 blocks all.** Every PR below imports `ConfirmDialog`, `useCanMutate`, `parseGraphQLError`, or the BatchDetail route.
- **PR-1 is soft-blocking PR-2 and PR-3** — those PRs add to `BatchDetailPage`; PR-1 puts the Tier 1 modals there and establishes the layout. If PR-1 slips, PR-2 and PR-3 can still land by adding their own modal-open buttons; but they'd trip over each other. Preferred: PR-1 before PR-2.
- **PR-4 → PR-5 → PR-8** share `MaintenanceSchedulesPage` and its per-schedule detail panel. Sequencing avoids merge conflicts.
- **PR-6 is independent** — lives on `WaterChemistryPage`.
- **PR-9 is independent** — `SetupPage > EquipmentTab` already renders `SubEquipmentModal`, we only add row action.
- **PR-10 is independent** — its own settings page.

**Tier 2 before Tier 3:** Yes. Tier 2 stabilizes the shared patterns (form + error-code map + ConfirmDialog) on simpler mutations. Tier 3 #6 (bulk grid) is the single biggest surface area in the phase — do it once the conventions are bedded in.

---

## 4. Per-mutation phases

Every phase follows a fixed template. "GraphQL operation" shows only the fields the UI actually needs, matching the conservative-payload convention in `useSubEquipment.ts`. "Validation rules" are the `errors: string[]` arms to add in the Tier 1 `useMemo` pattern — not zod.

### Phase 1  —  Wire up orphan Tier 1 modals  (PR-1)

- **Goal:** Attach the 4 orphan Tier 1 modals (`CloseBatchModal`, `UpdateBatchStatusModal`, `AllocateBatchToTankModal`, `AssignFeedsToBatchModal`) to `BatchDetailPage` so subsequent Tier 2 PRs have a surface to add actions onto.
- **Files touched:**
  - new — `web/modules/farm-module/src/pages/production/BatchDetailPage.tsx` (if not landed in PR-0; otherwise edit)
  - new — `web/modules/farm-module/src/pages/production/tabs/BatchOverviewTab.tsx`
  - new — `web/modules/farm-module/src/pages/production/tabs/BatchFeedingTab.tsx`
  - new — `web/modules/farm-module/src/pages/production/tabs/BatchTanksTab.tsx`
  - edit — `web/modules/farm-module/src/Module.tsx` (add route)
  - edit — `web/modules/farm-module/src/pages/production/tabs/BatchInputTab.tsx` (confirm `/sites/batch/:id` navigates live now)
- **GraphQL:** none new; uses existing `useBatch`, `useCloseBatch`, `useUpdateBatchStatus`, `useAllocateBatchToTank`, `useAssignFeedsToBatch`.
- **Validation rules:** none new.
- **Test plan:**
  - Component: `BatchOverviewTab.test.tsx` — render with a mock batch, assert each action button renders and opens its modal.
  - E2E (Playwright, `e2e/tests/modules/farm/batch-detail-page.spec.ts`): API-style — create batch via GraphQL, navigate to detail URL, assert page loads with batch number. No UI-driving for the modals yet; the modal logic is already unit-tested.
- **LOC / PR:** ~500 LOC / 1 PR.

---

### Phase 2.1  —  `updateBatch`  (Tier 2 #1)  (PR-2)

- **Goal:** Let operators edit a batch's metadata (name, expectedHarvestDate, targetFCR, notes) from the batch detail overview.
- **Files touched:**
  - new — `web/modules/farm-module/src/pages/production/components/UpdateBatchModal.tsx`
  - edit — `web/modules/farm-module/src/hooks/useBatches.ts` (add `useUpdateBatch`)
  - edit — `web/modules/farm-module/src/pages/production/tabs/BatchOverviewTab.tsx` (wire the "Düzenle" button; gate with `useCanMutate('updateBatch')`)
  - new — `web/modules/farm-module/src/pages/production/components/__tests__/UpdateBatchModal.test.tsx`
- **Pre-check query:** reuses the existing `useBatch(batchId)` call — no new read. The modal receives the current `Batch` as a prop.
- **GraphQL operation** (inline in `useBatches.ts`):
  ```
  mutation UpdateBatch($input: UpdateBatchInput!) {
    updateBatch(input: $input) {
      id name expectedHarvestDate targetFCR notes updatedAt version
    }
  }
  ```
  Input fields (mirroring `apps/farm-service/src/batch/dto/batch-resolver.dto.ts:53`): `id (required), name?, expectedHarvestDate?, targetFCR?, notes?`.
- **Validation rules** (Tier 1 `useMemo(errors)` style):
  - `name.trim().length === 0` → "İsim boş bırakılamaz" (or allow null since optional; only validate if non-empty)
  - `name.length > 255` → "İsim 255 karakteri aşamaz"
  - `expectedHarvestDate` before `stockedAt` → "Hasat tarihi stoklama tarihinden önce olamaz"
  - `targetFCR` outside [0.5, 5.0] → "Hedef FCR 0.5 ile 5.0 arasında olmalı"
  - `notes.length > 2000` → "Notlar 2000 karakteri aşamaz"
- **Optimistic UI:** No — `updatedAt` / `version` come from server; wait for roundtrip, then show toast. Consistent with Tier 1.
- **Authz gating:** Hide the "Düzenle" button when `!useCanMutate('updateBatch')`.
- **Error surface:** Map `BATCH_NOT_FOUND`, `BATCH_VERSION_MISMATCH` via `parseGraphQLError`.
- **Test plan:**
  - Component: happy path, validation error branch per rule above, backend error branch (mock a thrown `BATCH_VERSION_MISMATCH` and assert toast text comes from error-map).
  - E2E (`e2e/tests/modules/farm/batch-update.spec.ts`): API-style — create batch, call updateBatch, assert new metadata reads back. UI path: open detail page, click edit, confirm form pre-fills from batch.
- **LOC / PR:** ~300 LOC / 1 PR.

---

### Phase 2.2  —  `updateBatchFeedAssignment` + `deleteBatchFeedAssignment`  (Tier 2 #2, #3)  (PR-3)

Bundled because they share one tab and one row affordance.

- **Goal:** Per-row Edit and Delete on the `BatchFeedingTab` rendering of `useBatchFeedAssignments`.
- **Files touched:**
  - new — `web/modules/farm-module/src/pages/production/components/EditFeedAssignmentModal.tsx`
  - edit — `web/modules/farm-module/src/pages/production/tabs/BatchFeedingTab.tsx` (add row-level Edit/Delete, uses existing `useUpdateBatchFeedAssignment`, `useDeleteBatchFeedAssignment`)
  - new — `web/modules/farm-module/src/pages/production/components/__tests__/EditFeedAssignmentModal.test.tsx`
  - edit — `web/modules/farm-module/src/hooks/useBatchFeedAssignments.ts` — NONE (hooks already exist, confirmed at `useBatchFeedAssignments.ts:169,194`).
- **Pre-check query:** `useBatchFeedAssignmentsForBatch(batchId)` (already exists) populates the row; the modal receives the current `BatchFeedAssignment` as prop.
- **GraphQL operations:** already present in `useBatchFeedAssignments.ts` (`UPDATE_BATCH_FEED_ASSIGNMENT_MUTATION`, `DELETE_BATCH_FEED_ASSIGNMENT_MUTATION`). No new inline definitions.
- **Validation rules** (for edit modal):
  - `feedAssignments.length === 0` → "En az bir yem atamanız gerekir"
  - For each entry: `minWeightG >= maxWeightG` → "Min ağırlık max ağırlıktan küçük olmalı"
  - Overlapping weight ranges when `priority` is equal → "Aynı öncelikte çakışan ağırlık aralıkları olamaz"
  - `notes.length > 2000`
- **Delete:** uses `ConfirmDialog` from PR-0 — no cascade preview endpoint, plain "Yem ataması silinsin mi?"
- **Optimistic UI:**
  - Delete: **yes, optimistic with rollback on error** — list is a simple array, invalidate query on settle. Undo toast is a nice-to-have (fits the standing user rule "every PR carries validation + audit"; log structure is server-side so undo works out of the box if we requeue).
  - Edit: no — form values are server-round-tripped.
- **Authz gating:** Edit button hidden when `!useCanMutate('updateBatchFeedAssignment')` (MODULE_MANAGER+). Delete hidden when `!useCanMutate('deleteBatchFeedAssignment')` (TENANT_ADMIN only).
- **Error surface:** `FEED_ASSIGNMENT_NOT_FOUND`, `FEED_NOT_FOUND` (input validation), `FEED_ASSIGNMENT_IN_USE` if deletion is blocked by daily-feeding records (check backend service).
- **Test plan:**
  - Component × 2: Edit happy/validation/error, Delete confirm path.
  - E2E: API-driven create+update+delete round-trip in one file.
- **LOC / PR:** ~450 LOC / 1 PR (counts both modals).

---

### Phase 2.3  —  `generateWorkOrderFromSchedule`  (Tier 2 #4)  (PR-4)

- **Goal:** Per-schedule "İş Emri Oluştur" button on `MaintenanceSchedulesPage`.
- **Files touched:**
  - edit — `web/modules/farm-module/src/hooks/useMaintenance.ts` (add `useGenerateWorkOrderFromSchedule`)
  - edit — `web/modules/farm-module/src/pages/maintenance/MaintenanceSchedulesPage.tsx` (add button per row)
  - new — `web/modules/farm-module/src/pages/maintenance/components/GenerateWorkOrderButton.tsx` (lightweight — inline confirm + toast + navigate to new work order detail)
  - new — `__tests__/GenerateWorkOrderButton.test.tsx`
- **Pre-check query:** `useMaintenanceSchedule(scheduleId)` already exists and populates the row; no extra fetch needed. Disable the button when `schedule.status !== 'ACTIVE'`.
- **GraphQL operation** (inline):
  ```
  mutation GenerateWorkOrderFromSchedule($scheduleId: ID!) {
    generateWorkOrderFromSchedule(scheduleId: $scheduleId) {
      id workOrderNumber title status createdAt
    }
  }
  ```
- **Validation rules:** none client-side beyond the status guard.
- **Optimistic UI:** No — the generated work order's ID is the whole point of the response; must wait.
- **Authz gating:** button hidden when `!useCanMutate('generateWorkOrderFromSchedule')` (MODULE_MANAGER+).
- **Success UX:** toast "İş emri oluşturuldu" with "Görüntüle" action that navigates to `/sites/maintenance/work-orders?focus={id}` (the query-string focus is a convention already used by the existing page's `selectedWorkOrder` state — confirm during implementation).
- **Error surface:** `SCHEDULE_NOT_ACTIVE`, `SCHEDULE_HAS_OPEN_WORK_ORDER` (if backend enforces one-at-a-time).
- **Test plan:** component happy/error, E2E round-trip.
- **LOC / PR:** ~250 LOC / 1 PR.

---

### Phase 2.4  —  `completeMaintenance`  (Tier 2 #5)  (PR-5)

- **Goal:** Per-work-order "Tamamla" / "Bakımı Kapat" checklist-completion flow on `WorkOrdersPage`. **Note: this closes the underlying schedule (updates `lastMaintenanceAt`, optionally meter), distinct from `completeWorkOrder` which closes the work order row.** Backend resolver is at `apps/farm-service/src/maintenance/resolvers/maintenance-schedule.resolver.ts:304` and takes `CompleteMaintenanceInput { scheduleId, workOrderId?, meterReading?, notes? }`.
- **Files touched:**
  - edit — `web/modules/farm-module/src/hooks/useMaintenance.ts` (add `useCompleteMaintenance`)
  - new — `web/modules/farm-module/src/pages/maintenance/components/CompleteMaintenanceModal.tsx`
  - edit — `web/modules/farm-module/src/pages/maintenance/WorkOrdersPage.tsx` (swap or add-next-to the existing "Tamamla" action)
  - new — `__tests__/CompleteMaintenanceModal.test.tsx`
- **Pre-check query:** `useWorkOrder(id)` (exists) — need checklist state from the work order + linked schedule (`schedule.nextMaintenanceMeterReading` if meter-based). The modal receives both.
- **GraphQL operation** (inline):
  ```
  mutation CompleteMaintenance($input: CompleteMaintenanceInput!) {
    completeMaintenance(input: $input) {
      id status lastMaintenanceAt nextMaintenanceAt lastMaintenanceMeterReading nextMaintenanceMeterReading
    }
  }
  ```
- **Validation rules:**
  - all mandatory checklist items must be ticked (backend will also enforce but UI gates submit)
  - `meterReading >= schedule.lastMaintenanceMeterReading` (if meter-based; otherwise hide the field)
  - `notes.length > 2000`
- **Optimistic UI:** No — the schedule's `nextMaintenanceAt` is computed server-side; must wait.
- **Authz gating:** button hidden when `!useCanMutate('completeMaintenance')`.
- **Error surface:** `CHECKLIST_INCOMPLETE`, `METER_READING_NOT_INCREASING`, `SCHEDULE_NOT_ACTIVE`.
- **Test plan:** component — happy, checklist-incomplete validation, meter-not-increasing branch. E2E round-trip.
- **LOC / PR:** ~400 LOC / 1 PR.

---

### Phase 3.1  —  `createBatchWaterQualityMeasurements`  (Tier 3 #6)  (PR-6)

- **Goal:** Bulk multi-tank WQ entry grid on `WaterChemistryPage`.
- **Files touched:**
  - edit — `web/modules/farm-module/src/hooks/useWaterQuality.ts` (add `useCreateBatchWaterQualityMeasurements`)
  - new — `web/modules/farm-module/src/pages/water-chemistry/components/BulkMeasurementModal.tsx`
  - new — `web/modules/farm-module/src/pages/water-chemistry/components/BulkEntryGrid.tsx` (local, not shared — SetupPage has no similar need; hydroponics could copy later)
  - edit — `web/modules/farm-module/src/pages/water-chemistry/WaterChemistryPage.tsx` (add "Toplu Ölçüm" button)
  - new — `__tests__/BulkMeasurementModal.test.tsx`, `__tests__/BulkEntryGrid.test.tsx`
- **Pre-check query:** `useEquipmentParameters(equipmentTypeCode)` (exists) to know which dynamic parameters to render columns for; `useTanks()` or `useEquipment({ type: 'TANK' })` for the row axis.
- **GraphQL operation** (inline):
  ```
  mutation CreateBatchWaterQualityMeasurements($input: CreateBatchWaterQualityInput!) {
    createBatchWaterQualityMeasurements(input: $input) {
      id equipmentId measuredAt dynamicParameters status
    }
  }
  ```
  Input shape (from `apps/farm-service/src/water-quality/dto/create-batch-water-quality.input.ts:49`):
  `{ measuredAt, source, measurements: [{ equipmentId, dynamicParameters, idempotencyKey, notes? }, … ] }` capped at 50.
- **Validation rules:**
  - `measurements.length` between 1 and 50
  - each row: at least one parameter filled
  - each `idempotencyKey` is a fresh UUID (generated client-side via `crypto.randomUUID()`; guard against dupes within the grid)
  - parameter values respect their config min/max (pulled from `useEquipmentParameters`)
  - `measuredAt` not in the future, not older than 30 days (configurable)
- **Optimistic UI:** No — server assigns IDs, status, flags out-of-range.
- **Authz gating:** button hidden when `!useCanMutate('createBatchWaterQualityMeasurements')`.
- **Error surface:** partial-failure handling — backend may reject only some measurements. `parseGraphQLError` must surface per-row errors; the grid highlights failing rows.
- **Test plan:** component — empty-grid validation, row-limit validation, param-range validation, happy path with 3 rows; E2E round-trip posting 2 measurements.
- **LOC / PR:** ~800 LOC / 1 PR (largest).

---

### Phase 3.2  —  `processAutoGenerateWorkOrders`  (Tier 3 #7, admin)  (PR-7)

- **Goal:** Admin-only "Otomatik Üret" button on `MaintenanceSchedulesPage` that batches work-order creation for all due schedules.
- **Files touched:**
  - edit — `web/modules/farm-module/src/hooks/useMaintenance.ts` (add `useProcessAutoGenerateWorkOrders`)
  - edit — `web/modules/farm-module/src/pages/maintenance/MaintenanceSchedulesPage.tsx` (add button, gated)
  - new — `__tests__/MaintenanceSchedulesPage.autoGenerate.test.tsx`
- **Pre-check query:** `useUpcomingMaintenanceSchedules(7)` (exists) to show a pre-count ("şu an 12 planlanmış bakım uygunsa çalıştır"). Disable button when zero.
- **GraphQL operation** (inline):
  ```
  mutation ProcessAutoGenerateWorkOrders {
    processAutoGenerateWorkOrders {
      id workOrderNumber scheduleId status
    }
  }
  ```
- **Validation rules:** none; typed-confirmation in `ConfirmDialog` ("ONAYLIYORUM" to prevent fat-finger).
- **Optimistic UI:** No — list of generated work orders is the response payload.
- **Authz gating:** button hidden unless `useCanMutate('processAutoGenerateWorkOrders')` (TENANT_ADMIN only). The test must assert a MODULE_MANAGER cannot see the button.
- **Error surface:** `AUTO_GENERATE_THROTTLED` (if backend rate-limits).
- **Success UX:** toast reports count ("12 iş emri oluşturuldu").
- **Test plan:** component — admin visibility, non-admin hidden, typed-confirmation gate, success toast count. E2E round-trip posting as TENANT_ADMIN, asserting non-admin receives GraphQL 403.
- **LOC / PR:** ~200 LOC / 1 PR.

---

### Phase 3.3  —  `updateMeterReading`  (Tier 3 #8)  (PR-8)

- **Goal:** Meter reading input on the per-schedule detail view in `MaintenanceSchedulesPage`.
- **Files touched:**
  - edit — `web/modules/farm-module/src/hooks/useMaintenance.ts` (add `useUpdateMeterReading`)
  - new — `web/modules/farm-module/src/pages/maintenance/components/UpdateMeterReadingModal.tsx`
  - edit — `MaintenanceSchedulesPage.tsx` (add "Meter Güncelle" button for meter-based schedules)
  - new — `__tests__/UpdateMeterReadingModal.test.tsx`
- **Pre-check query:** `useMaintenanceSchedule(id)` (exists) — modal reads `lastMaintenanceMeterReading` to enforce non-decreasing input.
- **GraphQL operation** (inline):
  ```
  mutation UpdateMeterReading($input: UpdateMeterReadingInput!) {
    updateMeterReading(input: $input) {
      id currentMeterReading nextMaintenanceMeterReading updatedAt
    }
  }
  ```
  Input: `{ id: ID!, meterReading: Float! }` (from dto line 166).
- **Validation rules:**
  - `meterReading >= schedule.lastMaintenanceMeterReading` (strict or equal — backend has `@Min(0)`, we add domain rule)
  - `meterReading < 1e9` (sanity cap)
- **Optimistic UI:** Yes — simple scalar update; optimistically set the schedule's `currentMeterReading` and rollback on error. Low risk.
- **Authz gating:** hidden when `!useCanMutate('updateMeterReading')` (MODULE_MANAGER, MODULE_USER, TENANT_ADMIN).
- **Error surface:** `METER_READING_NOT_INCREASING`, `SCHEDULE_NOT_METER_BASED`.
- **Test plan:** component — validation, optimistic rollback on error, happy path. E2E round-trip.
- **LOC / PR:** ~250 LOC / 1 PR.

---

### Phase 4.1  —  `deleteSubEquipment`  (Sub-equipment CRUD #10)  (PR-9)

Note: `updateSubEquipment` is already shipped via the dual-mode `SubEquipmentModal` and the `useUpdateSubEquipment` hook. Only delete remains.

- **Goal:** Row-level "Sil" on the sub-equipment list inside `EquipmentTab`.
- **Files touched:**
  - edit — `web/modules/farm-module/src/pages/setup/tabs/EquipmentTab.tsx` — add delete button to sub-equipment row, wire `useDeleteSubEquipment` (exists at `useSubEquipment.ts:264`) through `ConfirmDialog`
  - new — `__tests__/EquipmentTab.subEquipmentDelete.test.tsx`
- **Pre-check query:** none server-side. The list query `useSubEquipmentByParent` already hydrates rows.
- **GraphQL operation:** already present (`DELETE_SUB_EQUIPMENT_MUTATION` in `useSubEquipment.ts:144`).
- **Validation rules:** none; `ConfirmDialog` does the "Are you sure" gate.
- **Optimistic UI:** Yes — remove from list on click; rollback + toast on error.
- **Authz gating:** hidden when `!useCanMutate('deleteSubEquipment')` (MODULE_MANAGER, TENANT_ADMIN).
- **Error surface:** `SUB_EQUIPMENT_IN_USE` (if backend blocks delete when referenced elsewhere).
- **Test plan:** component — admin visible, non-admin hidden, confirm→success, confirm→backend-reject→rollback. E2E round-trip.
- **LOC / PR:** ~150 LOC / 1 PR.

---

### Phase 5.1  —  `updateSentinelHubInstanceId` (admin-only)  (PR-10)

- **Goal:** Allow TENANT_ADMIN to update just the `instanceId` on a configured Sentinel Hub connection without re-entering credentials. The existing `saveSentinelHubSettings` mutation already accepts instanceId; we add the more ergonomic targeted mutation alongside it.
- **Files touched:**
  - edit — `web/modules/farm-module/src/hooks/useSentinelHub.ts` (add `useUpdateSentinelHubInstanceId`; note: the current file is plain callbacks, not React-Query mutations — the new hook should follow the React Query + `graphqlClient.request` pattern seen in `useSubEquipment.ts`, even if it sits alongside the callback-based code)
  - edit — `web/modules/farm-module/src/pages/settings/SentinelHubSettingsPage.tsx` — add "Sadece Instance ID güncelle" action (visible only when `status.isConfigured && status.instanceIdMasked`)
  - new — `__tests__/SentinelHubSettingsPage.updateInstance.test.tsx`
- **Pre-check query:** the existing `SENTINEL_HUB_STATUS_QUERY` — hide the "update instanceId alone" button when `!status.isConfigured`.
- **GraphQL operation** (inline):
  ```
  mutation UpdateSentinelHubInstanceId($instanceId: String!) {
    updateSentinelHubInstanceId(instanceId: $instanceId)
  }
  ```
- **Validation rules:**
  - `instanceId.trim().length > 0`
  - regex: loose UUID-ish (Sentinel Hub instanceIds are UUIDs) — warn if pattern doesn't match, don't hard-block (backend validates).
- **Optimistic UI:** No — need to re-query status to show masked update.
- **Authz gating:** hidden when `!useCanMutate('updateSentinelHubInstanceId')` (TENANT_ADMIN only).
- **Error surface:** `SENTINEL_HUB_NOT_CONFIGURED`, `INVALID_INSTANCE_ID`.
- **Test plan:** component — admin-only visibility, validation, happy path, error branch. E2E not needed for this settings-only mutation (skip; document rationale in the PR).
- **LOC / PR:** ~180 LOC / 1 PR.

---

## 5. Pre-registered findings

New IDs the phases should resolve, following the `FE-<severity>-NNN` / `FARM-<severity>-NNN` convention. Severity: HIGH = user-blocking or security-impacting, MEDIUM = UX gap, LOW = cleanup.

| ID | Severity | Description | Resolved by |
|---|---|---|---|
| **FE-HIGH-001** | HIGH | Frontend has no authorization gating for mutations; any role can see every action button. Backend rejects on submit which is poor UX. | PR-0 (§2.2 `useCanMutate`) + every subsequent PR applies it. |
| **FE-HIGH-002** | HIGH | `BatchInputTab.tsx:218` navigates to `/sites/batch/${batch.id}`, but no such route exists — broken link. | PR-0 or PR-1 (§2.4 BatchDetailPage + `Module.tsx` route). |
| **FE-MEDIUM-001** | MEDIUM | Tier 1 modals (`CloseBatchModal`, `UpdateBatchStatusModal`, `AllocateBatchToTankModal`, `AssignFeedsToBatchModal`) are implemented but never imported by any page. | PR-1 (Phase 1). |
| **FE-MEDIUM-002** | MEDIUM | Error-code parsing logic (`parseWithdrawalBlock`) is inlined in `CloseBatchModal`; every new Tier 2/3 modal would re-invent this. | PR-0 (§2.3 `useErrorMessage`). Refactor `CloseBatchModal` to use it in PR-1. |
| **FE-MEDIUM-003** | MEDIUM | `DeleteConfirmationDialog` requires a cascade-preview payload that few endpoints provide, so new deletes reach for `<Modal>` + two `<Button>`s directly, re-implementing the pattern. | PR-0 (§2.1 `ConfirmDialog`). |
| **FE-MEDIUM-004** | MEDIUM | `useSentinelHub.ts` uses plain `useState` + callback-based mutations rather than React Query's `useMutation`; inconsistent with the rest of farm-module. | PR-10 adds the new hook in the canonical React Query shape; larger refactor deferred. Tracked separately. |
| **FARM-LOW-001** | LOW | `graphql/` folder is half-populated (`feedingProgram.mutations.ts`, `feedingProgram.queries.ts` split) while most mutations live inline in hook files. Inconsistent convention. | Not resolved in this phase — add note to `DISCOVERY_LOG.md` for a future cleanup phase. |
| **FARM-LOW-002** | LOW | `completeWorkOrder` (work-order table) and `completeMaintenance` (schedule lifecycle) have confusingly similar user-facing labels ("Tamamla"). | PR-5 will differentiate labels: "İş Emrini Tamamla" vs. "Bakımı Kapat". |

---

## 6. Open questions (A/B choices requiring user decision)

1. **BatchDetailPage scope: full detail page in PR-0, or lazy?**
   - A. **Full skeleton in PR-0** (preferred): 3 tabs + route + wire 4 Tier 1 modals. Adds ~500 LOC to the shared-infra PR.
   - B. **Lazy:** PR-0 only adds ConfirmDialog/useCanMutate/errorMap; the route and tabs slide into PR-1. PR-0 stays small.
   - Recommendation: **A** — the route is currently a dead link (FE-HIGH-002) and PR-1 needs it anyway.

2. **Authz strategy: static matrix mirror vs. new backend query.**
   - A. **Static mirror** with parity unit test (§2.2). No GraphQL round-trip; test guards drift.
   - B. Add a backend `canMutate(name: String!): Boolean!` query. Extra resolver, extra roundtrip per render; but guaranteed single source of truth.
   - Recommendation: **A**. Roles change rarely; the parity test closes the drift risk. A `useCanMutate()` hook call is essentially free.

3. **Delete optimistic behavior: all deletes optimistic, or only simple ones?**
   - A. **Optimistic for `deleteBatchFeedAssignment`, `deleteSubEquipment`, `updateMeterReading`** (simple scalar/list mutations; backend failure = small list blip with rollback).
   - B. No optimistic — always wait for server. Slower feel but uniform.
   - Recommendation: **A** — aligns with the user's stated "confidence enough for optimistic update (e.g. delete is reversible via undo)" heuristic.

4. **Bulk WQ grid partial-failure behavior (PR-6).**
   - A. **All-or-nothing** — single mutation call; if any row fails, the whole submit fails.
   - B. **Per-row** — N parallel calls, grid shows per-row status. More code, more backend load, but better UX for 50-row entries.
   - Recommendation: **A** matches the backend signature (single mutation, `ArrayMaxSize(50)`), and the resolver is already transactional. Surface per-row error codes in the error response; highlight the offending row from `extensions.failedItems[]` if the backend returns it (confirm during implementation).

5. **Undo toast for deletes — build now or defer?**
   - A. Defer — toast only; undo requires requeue infrastructure.
   - B. Build — adds ~100 LOC to PR-0 (a `useUndo` primitive) and ~50 LOC per delete.
   - Recommendation: **A**. The backend is soft-delete for both feed assignment and sub-equipment, so a "oops" can be recovered via direct SQL in the rare worst case. Track as `FE-LOW-003` for a later phase.

6. **i18n strategy for error map (§2.3).**
   - A. Hardcode Turkish strings now — consistent with existing Tier 1 text ("Batch closed", mixed TR/EN).
   - B. Route through `useTranslation()` from `shared-ui/i18n`.
   - Recommendation: **A** for this phase; the standing note says "i18n is a separate plan." Keep strings as module-local constants so the later i18n sweep has a clear target.

7. **E2E depth: Playwright UI-driving vs. API-driving per phase.**
   - A. **API-driven only** (mirror existing `batch-status-transitions.spec.ts`) — fast, reliable, already the house style.
   - B. API + UI (Playwright clicks through modals) — higher fidelity, slower, fragile.
   - Recommendation: **A** for Tier 2/3 golden paths; add a single UI-smoke per phase only if time allows. Keep component tests (Vitest + React Testing Library) for the UI-level coverage.

---

## Critical Files for Implementation

- `/var/aqua-saas/web/modules/farm-module/src/pages/production/components/CloseBatchModal.tsx` — canonical Tier 1 pattern to replicate (including error-code parsing)
- `/var/aqua-saas/web/modules/farm-module/src/hooks/useSubEquipment.ts` — canonical hook pattern (inline GraphQL + React Query + invalidation)
- `/var/aqua-saas/web/shared-ui/src/index.ts` — exports surface (`Modal`, `Button`, `useToast`, `useAuth`, `graphqlClient`)
- `/var/aqua-saas/apps/farm-service/src/common/authz/permission-matrix.ts` — role matrix source of truth for frontend mirror
- `/var/aqua-saas/web/modules/farm-module/src/Module.tsx` — where new routes (BatchDetail) must be registered
