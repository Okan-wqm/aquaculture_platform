/**
 * Workforce scope — the modules whose people one caller may see, decided on the server (ADR-051 §1
 * `scoped('workforce')`, contract rule C2; ADR-054 draft PR-9; HR-HIGH-066).
 *
 * WHY: hr-service narrowed its people reads only when the client sent `moduleCode`, and a read by
 * id returned any employee of the tenant, so the module boundary was a UI filter. An operation
 * that declares `@Access.scoped('workforce')` and takes `@AccessCaller()` has its scope decided by
 * `decideAccess` from the verified `moduleAccess` claim (TENANT_ADMIN and an hr grant: ALL; a farm
 * or sensor grant: that module; no grant: denied before the body runs). While hr-service is
 * `account-role`, RolesGuard still admits by the global role first; the parameter decides the
 * scope, and so it does once hr-service enrols.
 *
 * WHAT: `workforceScopeOf` returns that scope narrowed by the client's optional `moduleCode`
 * (`narrowModuleScope`): no argument keeps it, a module inside it narrows to that module, any other
 * module is FORBIDDEN, so no argument can widen it. The handlers apply the result through
 * `applyEmployeeScope` / `employeeScopeWhere` (common/module-scope.ts), which fail closed.
 */
import type { AccessCaller } from '@aquaculture/backend-common/decorators';
import {
  ScopeWideningError,
  narrowModuleScope,
  type ModuleScope,
  type OwnerModuleCode,
} from '@aquaculture/shared-contracts';
import { ForbiddenException } from '@nestjs/common';

export function workforceScopeOf(
  access: AccessCaller,
  requested?: OwnerModuleCode | null,
): ModuleScope {
  const { spec, moduleScope } = access;
  if (spec.kind !== 'scoped' || spec.scope !== 'workforce' || moduleScope === null) {
    // A handler that asks for a workforce scope under another spec is a programming error.
    throw new TypeError(`workforceScopeOf needs a scoped('workforce') decision, got ${spec.kind}`);
  }
  try {
    return narrowModuleScope(moduleScope, requested);
  } catch (error: unknown) {
    if (error instanceof ScopeWideningError) {
      throw new ForbiddenException('That module is outside your workforce scope');
    }
    throw error;
  }
}
