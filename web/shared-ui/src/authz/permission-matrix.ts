/**
 * Frontend Permission Matrix (Mirror)
 * ================================================================
 *
 * Mirror of the backend's `apps/farm-service/src/common/authz/permission-matrix.ts`
 * — the subset of mutations the frontend needs to gate rendering on.
 *
 * # Why a mirror instead of a backend query
 *
 * The backend matrix is the single source of truth at the GraphQL
 * layer; a user without a required role receives a 403 on submit.
 * Two reasons the frontend still needs its own copy:
 *
 *   1. **UX.** Buttons should not render when the user cannot act —
 *      seeing a disabled / hidden control is less confusing than
 *      submitting and getting rejected.
 *   2. **Round-trip cost.** An extra `canMutate(name)` GraphQL query
 *      per render of every gated button is wasteful when the answer
 *      is a pure function of the already-known user role.
 *
 * The drift risk (backend adds a role but this file isn't updated)
 * is closed by the parity test in
 * `__tests__/permission-matrix.parity.test.ts` — it reads the
 * backend source at test time and asserts key-by-key equality for
 * every mutation this file lists.
 *
 * # Scope — what to add here, what NOT to add
 *
 * Only add a mutation when the frontend actually renders a gated
 * button / menu-item / form-action for it. The backend matrix has
 * hundreds of entries; only the handful the UI surfaces belong
 * here. Adding every entry would make the parity test a
 * compile-all-of-permission-matrix exercise and add noise.
 *
 * When a new frontend surface needs a gate, add the mutation here,
 * re-run the parity test, and the `useCanMutate(name)` hook picks
 * it up automatically.
 */
import type { UserRole } from '../types';

/**
 * Role-set required to call a given mutation. A user whose role is
 * IN the array may invoke; any other role is gated out.
 *
 * NOTE: `SUPER_ADMIN` is always allowed — the `useCanMutate` hook
 * treats it as god-mode and short-circuits before checking the
 * matrix. That matches the backend's behaviour where super-admin
 * never hits `@Roles(...)` gate rejection.
 */
export type FrontendMutationName =
  // Phase 3 Tier 1 (already shipped) — we include them here so the
  // parity test catches any backend role-drift across the whole
  // farm-module surface, not only the Tier 2/3 additions.
  | 'updateBatchStatus'
  | 'closeBatch'
  | 'allocateBatchToTank'
  | 'createSubEquipment'
  | 'assignFeedsToBatch'
  // Phase 3 Tier 2 (Scope C PR-2..PR-5)
  | 'updateBatch'
  | 'updateBatchFeedAssignment'
  | 'deleteBatchFeedAssignment'
  | 'generateWorkOrderFromSchedule'
  | 'completeMaintenance'
  // Phase 3 Tier 3 (Scope C PR-6..PR-8)
  | 'createBatchWaterQualityMeasurements'
  | 'processAutoGenerateWorkOrders'
  | 'updateMeterReading'
  // Sub-Equipment CRUD (Scope C PR-9)
  | 'updateSubEquipment'
  | 'deleteSubEquipment'
  // Admin-only (Scope C PR-10)
  | 'updateSentinelHubInstanceId'
  // Scope A Phase 4.4.2 — supplier ↔ site approvals
  | 'setSupplierApprovedSites'
  // Scope A Phase 4.4.3 — per-site contact upsert
  | 'upsertSiteContacts'
  // Finance capability — farm finance tab mutations
  | 'createFinanceEntry'
  | 'updateFinanceEntry'
  | 'deleteFinanceEntry'
  | 'createFinanceCategory'
  | 'updateFinanceCategory'
  | 'archiveFinanceCategory'
  | 'restoreFinanceCategory'
  | 'updateFinanceSettings'
  // Feeding Protocol v2 (feeding-protocol SSoT Faz 3) — ProtocolBuilderTab +
  // AssignmentsTab gated buttons
  | 'createFeedingProtocolV2'
  | 'updateFeedingProtocolV2'
  | 'archiveFeedingProtocolV2'
  | 'assignProtocolToUnit'
  | 'updateProtocolAssignment'
  | 'unassignProtocolFromUnit';

/**
 * Source-of-frontend-truth role matrix. Mirrors the backend's
 * `MUTATION_ROLES` entries one-to-one.
 *
 * Update procedure when adding a new mutation:
 *   1. Confirm the backend's role list in
 *      `apps/farm-service/src/common/authz/permission-matrix.ts`.
 *   2. Add the mutation to the `FrontendMutationName` union above.
 *   3. Add the matching entry here.
 *   4. Run `npx vitest --run permission-matrix.parity` — if it
 *      fails you've diverged from the backend.
 */
export const FRONTEND_MUTATION_ROLES: Readonly<
  Record<FrontendMutationName, readonly UserRole[]>
> = Object.freeze({
  // Phase 3 Tier 1
  updateBatchStatus: ['MODULE_MANAGER', 'MODULE_USER', 'TENANT_ADMIN'],
  closeBatch: ['MODULE_MANAGER', 'MODULE_USER', 'TENANT_ADMIN'],
  allocateBatchToTank: ['MODULE_MANAGER', 'MODULE_USER', 'TENANT_ADMIN'],
  createSubEquipment: ['MODULE_MANAGER', 'MODULE_USER', 'TENANT_ADMIN'],
  assignFeedsToBatch: ['MODULE_MANAGER', 'TENANT_ADMIN'],
  // Phase 3 Tier 2
  updateBatch: ['MODULE_MANAGER', 'MODULE_USER', 'TENANT_ADMIN'],
  updateBatchFeedAssignment: ['MODULE_MANAGER', 'TENANT_ADMIN'],
  deleteBatchFeedAssignment: ['TENANT_ADMIN'],
  generateWorkOrderFromSchedule: ['MODULE_MANAGER', 'TENANT_ADMIN'],
  completeMaintenance: ['MODULE_MANAGER', 'MODULE_USER', 'TENANT_ADMIN'],
  // Phase 3 Tier 3
  createBatchWaterQualityMeasurements: [
    'MODULE_MANAGER',
    'MODULE_USER',
    'TENANT_ADMIN',
  ],
  processAutoGenerateWorkOrders: ['TENANT_ADMIN'],
  updateMeterReading: ['MODULE_MANAGER', 'MODULE_USER', 'TENANT_ADMIN'],
  // Sub-Equipment CRUD
  updateSubEquipment: ['MODULE_MANAGER', 'MODULE_USER', 'TENANT_ADMIN'],
  deleteSubEquipment: ['MODULE_MANAGER', 'TENANT_ADMIN'],
  // Admin-only
  updateSentinelHubInstanceId: ['TENANT_ADMIN'],
  // Scope A Phase 4.4.2 — supplier ↔ site approvals
  setSupplierApprovedSites: ['MODULE_MANAGER', 'TENANT_ADMIN'],
  // Scope A Phase 4.4.3 — per-site contact upsert
  upsertSiteContacts: ['MODULE_MANAGER', 'TENANT_ADMIN'],
  // Finance capability — mirrors apps/farm-service/src/common/authz/permission-matrix.ts
  createFinanceEntry: ['MODULE_MANAGER', 'TENANT_ADMIN'],
  updateFinanceEntry: ['MODULE_MANAGER', 'TENANT_ADMIN'],
  deleteFinanceEntry: ['MODULE_MANAGER', 'TENANT_ADMIN'],
  createFinanceCategory: ['MODULE_MANAGER', 'TENANT_ADMIN'],
  updateFinanceCategory: ['MODULE_MANAGER', 'TENANT_ADMIN'],
  archiveFinanceCategory: ['TENANT_ADMIN'],
  restoreFinanceCategory: ['TENANT_ADMIN'],
  updateFinanceSettings: ['TENANT_ADMIN'],
  // Feeding Protocol v2 — mirrors apps/farm-service/src/common/authz/permission-matrix.ts
  createFeedingProtocolV2: ['MODULE_MANAGER', 'TENANT_ADMIN'],
  updateFeedingProtocolV2: ['MODULE_MANAGER', 'TENANT_ADMIN'],
  archiveFeedingProtocolV2: ['MODULE_MANAGER', 'TENANT_ADMIN'],
  assignProtocolToUnit: ['MODULE_MANAGER', 'TENANT_ADMIN'],
  updateProtocolAssignment: ['MODULE_MANAGER', 'TENANT_ADMIN'],
  unassignProtocolFromUnit: ['MODULE_MANAGER', 'TENANT_ADMIN'],
});
