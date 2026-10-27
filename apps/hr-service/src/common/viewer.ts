/**
 * The viewer — who is asking an hr-service operation, and which employee record is theirs.
 *
 * Three questions used to be answered separately in every resolver and handler that needed them:
 * is the viewer a workforce manager (the attendance resolver, the leave resolver and the employee
 * resolver each spelled it, with different spellings of the roles), which HR employee is the viewer
 * (a lookup by `userId` written out in six leave handlers and five resolvers), and is this record
 * theirs. Asking here keeps the answers the same, and keeps them consistent with `RolesGuard`: the
 * role claims are read the way the guard reads them (upper-cased, the legacy single `role` honoured,
 * the role hierarchy applied), so `@Roles(TENANT_ADMIN, MODULE_MANAGER)` on an operation and
 * `isWorkforceManager` inside it never disagree about a SUPER_ADMIN.
 *
 * The auth user id (`sub`) and the HR employee id are two namespaces linked only by
 * `Employee.userId`. Nothing here compares one with the other: `findViewerEmployee` bridges them
 * once, and the record checks compare employee ids with employee ids.
 */
import { ForbiddenException } from '@nestjs/common';
import { PLATFORM_ROLES, Role, hasAnyRole } from '@aquaculture/backend-common/decorators';
import type { CurrentUserPayload } from '@aquaculture/backend-common/decorators';
import type { EntityManager } from 'typeorm';

import { Employee } from '../hr/entities/employee.entity';

/** The claims every check reads; both `@CurrentUser()` and `context.req.user` satisfy it. */
export type ViewerClaims = Pick<CurrentUserPayload, 'sub'> &
  Partial<Pick<CurrentUserPayload, 'role' | 'roles'>>;

/** The viewer's own HR employee record, reduced to what the scope rules need. */
export type ViewerEmployee = Pick<Employee, 'id' | 'departmentHrId'>;

const PLATFORM_ROLE_NAMES: ReadonlySet<string> = new Set<string>(PLATFORM_ROLES);

function isPlatformRole(value: string): value is Role {
  return PLATFORM_ROLE_NAMES.has(value);
}

function claimedRoles(viewer: ViewerClaims): Role[] {
  const claimed = [...(viewer.roles ?? []), ...(viewer.role ? [viewer.role] : [])];
  return claimed.map((role) => String(role).toUpperCase()).filter(isPlatformRole);
}

function holdsAny(viewer: ViewerClaims, required: Role[]): boolean {
  return claimedRoles(viewer).some((role) => hasAnyRole(role, required));
}

/** A tenant administrator (or a platform administrator acting for the tenant). */
export function isTenantAdmin(viewer: ViewerClaims): boolean {
  return holdsAny(viewer, [Role.TENANT_ADMIN]);
}

/** A workforce manager: a tenant administrator or a module manager. */
export function isWorkforceManager(viewer: ViewerClaims): boolean {
  return holdsAny(viewer, [Role.TENANT_ADMIN, Role.MODULE_MANAGER]);
}

/** Whether a record that carries an auth user id belongs to the viewer. */
export function isSameUser(
  subjectUserId: string | null | undefined,
  viewer: ViewerClaims,
): boolean {
  return !!subjectUserId && subjectUserId === viewer.sub;
}

/**
 * The viewer's HR employee record, or null: a tenant administrator or owner need not have one.
 * Only the id and the department are read: the whole entity would decrypt the national id and the
 * bank details for nothing. Resolvers pass `repository.manager`, handlers the manager of their
 * transaction.
 */
export function findViewerEmployee(
  manager: EntityManager,
  tenantId: string,
  viewer: ViewerClaims,
): Promise<ViewerEmployee | null> {
  return manager.findOne(Employee, {
    where: { userId: viewer.sub, tenantId, isDeleted: false },
    select: ['id', 'departmentHrId'],
  });
}

/** Whether the record of `subjectEmployeeId` is the viewer's own. */
export function isOwnRecord(
  viewerEmployee: Pick<ViewerEmployee, 'id'> | null,
  subjectEmployeeId: string,
): boolean {
  return viewerEmployee !== null && viewerEmployee.id === subjectEmployeeId;
}

/**
 * Refuses an approver acting on their own record. A viewer with no employee record has none to
 * act on, so nothing is refused.
 */
export function assertNotOwnRecord(
  viewerEmployee: Pick<ViewerEmployee, 'id'> | null,
  subjectEmployeeId: string,
  deniedMessage: string,
): void {
  if (isOwnRecord(viewerEmployee, subjectEmployeeId)) {
    throw new ForbiddenException(deniedMessage);
  }
}

/**
 * Refuses unless the record is the viewer's own: the acts only the subject performs, such as
 * answering their own review. A viewer with no employee record has no record of their own.
 */
export function assertOwnRecord(
  viewerEmployee: Pick<ViewerEmployee, 'id'> | null,
  subjectEmployeeId: string,
  deniedMessage: string,
): void {
  if (!isOwnRecord(viewerEmployee, subjectEmployeeId)) {
    throw new ForbiddenException(deniedMessage);
  }
}
