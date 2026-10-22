import { ConflictException } from '@nestjs/common';
import { EntityManager, Not, Raw } from 'typeorm';
import { tenantManagerRepo } from '@aquaculture/backend-common/database';

import { DepartmentHR } from '../entities/department.entity';

/**
 * Where a code that is already taken lives, in words an admin who cannot see that department
 * (another module's, a company-wide one, a deleted one) can act on.
 */
function describeHolder(holder: DepartmentHR): string {
  if (holder.isDeleted) return 'a deleted department';
  return `a ${holder.moduleCode ?? 'company-wide'} department`;
}

/**
 * A department code is unique per tenant across every module and across deleted rows (unique index
 * on tenantId + code), and compared WITHOUT regard to letter case: the index itself is
 * case-sensitive, so 'OPS' and 'ops' can both exist in old data, and the retire-legacy-department
 * migration recognises a department by `upper(code)` — a new 'ops' next to an 'OPS' would be the
 * duplicate that rule exists to avoid. The code is never normalised here; the admin's spelling is
 * stored and reported as typed. Both the create and the update handler ask this one function, so
 * the rule and its message are spelled once. Runs on the caller's transaction manager; the
 * tenant-scoped repository merges the tenant into the predicate.
 *
 * Case variants can already coexist, so more than one row may match: a live holder is named before
 * a deleted one, then the oldest, so the message does not depend on row order.
 *
 * `ownDepartmentId` is the department being renamed: its own row is not a holder. Without it a
 * case-only change of a department's own code ('ops' -> 'OPS') would collide with itself.
 *
 * @throws ConflictException naming where the code already lives.
 */
export async function assertDepartmentCodeFree(
  manager: EntityManager,
  tenantId: string,
  code: string,
  ownDepartmentId?: string,
): Promise<void> {
  const holder = await tenantManagerRepo(manager, DepartmentHR, tenantId).findOne({
    where: {
      // A bound parameter, not ILIKE: `_` is common in codes and must not act as a wildcard.
      code: Raw((column) => `upper(${column}) = upper(:departmentCode)`, { departmentCode: code }),
      ...(ownDepartmentId === undefined ? {} : { id: Not(ownDepartmentId) }),
    },
    order: { isDeleted: 'ASC', createdAt: 'ASC', id: 'ASC' },
  });
  if (!holder) return;
  throw new ConflictException(
    `Department code '${code}' already exists on ${describeHolder(holder)} (codes are unique across every module)`,
  );
}
