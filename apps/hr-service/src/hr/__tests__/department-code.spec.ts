/**
 * A department code is unique per tenant across EVERY module and across deleted rows (the index is
 * (tenantId, code)). A module's department list hides the other modules' departments, so the
 * refusal must say whose code it collided with — "already exists" about something the admin
 * cannot see reads like a bug. Codes collide regardless of letter case: the index is
 * case-sensitive, so rows such as 'OPS' and 'ops' can coexist in old data, and the handlers must
 * not add another variant.
 */
import { ConflictException } from '@nestjs/common';
import { EntityManager, FindOperator } from 'typeorm';

import { OWNER_MODULE } from '@aquaculture/shared-contracts';
import { DepartmentHR } from '../entities/department.entity';
import { assertDepartmentCodeFree } from '../services/department-code';

const tenantId = 'tenant-uuid-001';

function holder(overrides: Partial<DepartmentHR>): DepartmentHR {
  return Object.assign(new DepartmentHR(), {
    id: 'dept-1',
    tenantId,
    code: 'OPS',
    isDeleted: false,
    ...overrides,
  });
}

/** Only getRepository is reachable from tenantManagerRepo; the Partial needs no cast to act as a manager. */
function managerHolding(found: DepartmentHR | null): {
  manager: EntityManager;
  findOne: jest.Mock;
} {
  const findOne = jest.fn().mockResolvedValue(found);
  const partial: Partial<EntityManager> = { getRepository: jest.fn().mockReturnValue({ findOne }) };
  return { manager: partial as EntityManager, findOne };
}

/** The lookup the function sent to the repository: its `where`, with `code` read as the raw operator it is. */
function sentLookup(findOne: jest.Mock): {
  where: Record<string, unknown>;
  code: FindOperator<unknown>;
  order: unknown;
} {
  const [options] = findOne.mock.calls[0] as [{ where: Record<string, unknown>; order: unknown }];
  const code = options.where['code'];
  if (!(code instanceof FindOperator)) throw new Error('the code predicate is not a find operator');
  return { where: options.where, code, order: options.order };
}

describe('assertDepartmentCodeFree', () => {
  it('lets a free code through', async () => {
    const { manager } = managerHolding(null);

    await expect(assertDepartmentCodeFree(manager, tenantId, 'NEW')).resolves.toBeUndefined();
  });

  it('looks across every module and across deleted departments', async () => {
    const { manager, findOne } = managerHolding(null);

    await assertDepartmentCodeFree(manager, tenantId, 'OPS');

    // tenantId is merged in by the scoped repository; no isDeleted/module condition narrows the lookup.
    const { where } = sentLookup(findOne);
    expect(Object.keys(where)).toEqual(['code', 'tenantId']);
    expect(where['tenantId']).toBe(tenantId);
  });

  it('compares the codes case-insensitively: a new code `ops` collides with an existing `OPS`', async () => {
    const { manager, findOne } = managerHolding(null);

    await assertDepartmentCodeFree(manager, tenantId, 'ops');

    const { code } = sentLookup(findOne);
    expect(code.type).toBe('raw');
    // Both sides are upper-cased: the same rule the retire-legacy-department migration reuses rows by.
    expect(code.getSql?.('d.code')).toBe('upper(d.code) = upper(:departmentCode)');
    // The code travels as a bound parameter, exactly as typed: not normalised, and no LIKE wildcard
    // (`_` is common in codes) can widen the match.
    expect(code.objectLiteralParameters).toEqual({ departmentCode: 'ops' });
  });

  it('does not count the department being renamed as the holder of its own code (case-only rename)', async () => {
    const { manager, findOne } = managerHolding(null);

    await assertDepartmentCodeFree(manager, tenantId, 'OPS', 'dept-1');

    const idPredicate = sentLookup(findOne).where['id'];
    expect(idPredicate).toBeInstanceOf(FindOperator);
    expect(idPredicate).toMatchObject({ type: 'not', value: 'dept-1' });
  });

  it('reports the code the way the admin typed it, not the casing of the department that holds it', async () => {
    const { manager } = managerHolding(holder({ code: 'OPS', moduleCode: OWNER_MODULE.FARM }));

    await expect(assertDepartmentCodeFree(manager, tenantId, 'ops')).rejects.toThrow(
      "Department code 'ops' already exists on a farm department (codes are unique across every module)",
    );
  });

  it('names a live holder before a deleted one, then the oldest, when several case variants match', async () => {
    const { manager, findOne } = managerHolding(null);

    await assertDepartmentCodeFree(manager, tenantId, 'OPS');

    // Old data may hold 'OPS' and 'ops' side by side; the message must not depend on row order.
    expect(sentLookup(findOne).order).toEqual({ isDeleted: 'ASC', createdAt: 'ASC', id: 'ASC' });
  });

  it('names the module that owns a code the admin may not be able to see', async () => {
    const { manager } = managerHolding(holder({ moduleCode: OWNER_MODULE.FARM }));

    await expect(assertDepartmentCodeFree(manager, tenantId, 'OPS')).rejects.toThrow(
      "Department code 'OPS' already exists on a farm department (codes are unique across every module)",
    );
  });

  it('says company-wide for a department that belongs to no module', async () => {
    const { manager } = managerHolding(holder({ moduleCode: undefined }));

    await expect(assertDepartmentCodeFree(manager, tenantId, 'OPS')).rejects.toThrow(
      /company-wide department/,
    );
  });

  it('says so when the code is held by a deleted department', async () => {
    const { manager } = managerHolding(holder({ isDeleted: true }));

    await expect(assertDepartmentCodeFree(manager, tenantId, 'OPS')).rejects.toThrow(
      /already exists on a deleted department/,
    );
  });

  it('refuses with a ConflictException', async () => {
    const { manager } = managerHolding(holder({}));

    await expect(assertDepartmentCodeFree(manager, tenantId, 'OPS')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});
