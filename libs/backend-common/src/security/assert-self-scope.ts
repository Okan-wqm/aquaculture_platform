import { ForbiddenException } from '@nestjs/common';

import { Role, roleHasPermission } from '../decorators/roles.decorator';

/**
 * Caller identity for a direct-namespace self-scope authorization check.
 *
 * `sub` is the authenticated auth-service userId (JWT subject). `roles` are the
 * canonical {@link Role} values the JWT guard has already validated.
 */
export interface SelfScopeCaller {
  sub: string;
  roles: Role[];
}

export interface AssertSelfOrManagerArgs {
  /**
   * The owner of the record being mutated, expressed in the SAME identity
   * namespace as `caller.sub` (the auth-service userId). For task lifecycle
   * mutations this is `task.assignedTo`, which is stored as the assignee's
   * auth userId — a DIRECT equality with `caller.sub`.
   */
  ownerId: string | null | undefined;
  caller: SelfScopeCaller;
}

/**
 * SEC-HIGH-050 — canonical self-scope authorization SSoT.
 *
 * WHY: object-level mutations (a worker completing/starting/noting a task)
 * must only be allowed for the record's OWNER or a supervisor. Coarse
 * `@Roles(...)` gates only prove tenant membership, so without this any
 * MODULE_USER could mutate any colleague's record. This is the tier-1 layer
 * BENEATH the role gate.
 *
 * WHAT: allow iff
 *   (a) the caller is the owner — `ownerId != null && caller.sub === ownerId`, OR
 *   (b) the caller holds MODULE_MANAGER or higher via the canonical role
 *       hierarchy (`roleHasPermission(role, Role.MODULE_MANAGER)`).
 * Otherwise throw `ForbiddenException`.
 *
 * FAIL-CLOSED: an empty/unknown role set AND a non-owner => deny; a
 * null/undefined `ownerId` for a non-manager => deny (an unresolved owner is
 * never an implicit allow). The MODULE_MANAGER+ bypass itself flows through the
 * canonical {@link roleHasPermission} hierarchy — never a parallel string check.
 *
 * SCOPE: this helper is for DIRECT auth-userId owners only (tasks). Identity
 * namespaces that need a bridge (HR leave: auth userId -> Employee.id) keep
 * their own assertion inside the owning service — forcing one cross-namespace
 * function would be a layering violation (backend-common must not know HR's
 * Employee table). The "one self-scope shape" SSoT is honoured as a PATTERN
 * (owner-or-manager + canonical hierarchy bypass), reused not duplicated.
 */
export function assertSelfOrManager(args: AssertSelfOrManagerArgs): void {
  const { ownerId, caller } = args;

  const isOwner = ownerId != null && caller.sub === ownerId;
  if (isOwner) {
    return;
  }

  const isManagerOrHigher = caller.roles.some((role) =>
    roleHasPermission(role, Role.MODULE_MANAGER),
  );
  if (isManagerOrHigher) {
    return;
  }

  // SECURITY: generic message — never disclose ownership or role detail.
  throw new ForbiddenException('Access denied');
}
