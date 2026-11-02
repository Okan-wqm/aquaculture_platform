/**
 * The viewer — who is asking, and which employee record is theirs (common/viewer.ts).
 *
 * The role answers must match `RolesGuard`, so `@Roles(TENANT_ADMIN, MODULE_MANAGER)` on an
 * operation and `isWorkforceManager` inside it never disagree; the record answers compare HR
 * employee ids with HR employee ids and never an auth user id with either.
 */
import { ForbiddenException } from '@nestjs/common';
import { Role } from '@aquaculture/backend-common/decorators';
import type { EntityManager } from 'typeorm';

import { Employee } from '../../hr/entities/employee.entity';
import {
  assertNotOwnRecord,
  assertOwnRecord,
  findViewerEmployee,
  isOwnRecord,
  isSameUser,
  isTenantAdmin,
  isWorkforceManager,
} from '../viewer';

const viewer = (roles: string[], role?: string) => ({ sub: 'user-1', roles, role });

describe('role claims', () => {
  it.each([
    [[Role.TENANT_ADMIN], true, true],
    [[Role.SUPER_ADMIN], true, true],
    [[Role.MODULE_MANAGER], false, true],
    [[Role.MODULE_USER], false, false],
    [[Role.MODULE_USER, Role.MODULE_MANAGER], false, true],
    [[], false, false],
  ])('%j → tenant admin %s, workforce manager %s', (roles, admin, manager) => {
    expect(isTenantAdmin(viewer(roles))).toBe(admin);
    expect(isWorkforceManager(viewer(roles))).toBe(manager);
  });

  it('reads the claims the way RolesGuard does: any case, and the legacy single role', () => {
    expect(isWorkforceManager(viewer(['module_manager']))).toBe(true);
    expect(isTenantAdmin(viewer([], Role.TENANT_ADMIN))).toBe(true);
  });

  it('ignores a role the platform does not define', () => {
    expect(isWorkforceManager(viewer(['AUDITOR', 'OWNER']))).toBe(false);
  });

  it('a viewer without role claims at all is nobody', () => {
    expect(isWorkforceManager({ sub: 'user-1' })).toBe(false);
  });
});

describe('record ownership', () => {
  it('isSameUser compares auth user ids only, and a record with none is nobody’s', () => {
    expect(isSameUser('user-1', viewer([]))).toBe(true);
    expect(isSameUser('user-2', viewer([]))).toBe(false);
    expect(isSameUser(null, viewer([]))).toBe(false);
    expect(isSameUser(undefined, viewer([]))).toBe(false);
  });

  it('isOwnRecord compares employee ids; a viewer with no employee record owns nothing', () => {
    expect(isOwnRecord({ id: 'emp-1' }, 'emp-1')).toBe(true);
    expect(isOwnRecord({ id: 'emp-1' }, 'emp-2')).toBe(false);
    expect(isOwnRecord(null, 'emp-1')).toBe(false);
  });

  it('assertNotOwnRecord refuses the viewer’s own record and nothing else', () => {
    expect(() => assertNotOwnRecord({ id: 'emp-1' }, 'emp-1', 'no self')).toThrow(
      new ForbiddenException('no self'),
    );
    expect(() => assertNotOwnRecord({ id: 'emp-1' }, 'emp-2', 'no self')).not.toThrow();
    expect(() => assertNotOwnRecord(null, 'emp-1', 'no self')).not.toThrow();
  });

  it('assertOwnRecord refuses everything but the viewer’s own record', () => {
    expect(() => assertOwnRecord({ id: 'emp-1' }, 'emp-1', 'only you')).not.toThrow();
    expect(() => assertOwnRecord({ id: 'emp-1' }, 'emp-2', 'only you')).toThrow(
      new ForbiddenException('only you'),
    );
    expect(() => assertOwnRecord(null, 'emp-1', 'only you')).toThrow(ForbiddenException);
  });
});

describe('findViewerEmployee', () => {
  it('bridges the auth user id to the HR employee, reading only the id and the department', async () => {
    const findOne = jest.fn().mockResolvedValue({ id: 'emp-1', departmentHrId: 'dept-1' });
    const manager: Partial<EntityManager> = { findOne };

    const found = await findViewerEmployee(manager as EntityManager, 'tenant-1', viewer([]));

    expect(found).toEqual({ id: 'emp-1', departmentHrId: 'dept-1' });
    expect(findOne).toHaveBeenCalledWith(Employee, {
      where: { userId: 'user-1', tenantId: 'tenant-1', isDeleted: false },
      select: ['id', 'departmentHrId'],
    });
  });
});
