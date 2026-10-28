/**
 * Approval scope — the one rule for which department a pending-approval queue (leave, attendance)
 * narrows to. The two queues used to spell it separately and drifted: one narrowed through the
 * employee's live department, the other through a per-record snapshot that goes stale when an
 * employee is moved.
 */
import type { Repository, SelectQueryBuilder } from 'typeorm';

import { Employee } from '../../hr/entities/employee.entity';
import { OWNER_MODULE } from '@aquaculture/shared-contracts';
import { applyApprovalDepartment, resolveApprovalDepartment } from '../approval-scope';

const tenantId = 'tenant-1';
const approverId = 'approver-employee';

function employeeRepository(approver: Partial<Employee> | null): {
  repository: Repository<Employee>;
  findOne: jest.Mock;
} {
  const findOne = jest.fn().mockResolvedValue(approver);
  // Only findOne is reachable from resolveApprovalDepartment; the double is declared as a Partial
  // so a single assertion hands it over as the repository.
  const partial: Partial<Repository<Employee>> = { findOne };
  return { repository: partial as Repository<Employee>, findOne };
}

describe('resolveApprovalDepartment', () => {
  const request = { tenantId, approverId, narrowToOwnDepartment: true };

  it("narrows a manager to their own department, looked up by the approver's EMPLOYEE id", async () => {
    const { repository, findOne } = employeeRepository({
      id: approverId,
      departmentHrId: 'dept-1',
    });

    const resolved = await resolveApprovalDepartment(repository, request);

    expect(resolved).toEqual({ kind: 'narrow', departmentId: 'dept-1' });
    expect(findOne).toHaveBeenCalledWith({
      where: { id: approverId, tenantId, isDeleted: false },
      select: ['id', 'departmentHrId'],
    });
  });

  it('lets an explicit department win without looking the approver up', async () => {
    const { repository, findOne } = employeeRepository(null);

    const resolved = await resolveApprovalDepartment(repository, {
      ...request,
      departmentId: 'dept-x',
    });

    expect(resolved).toEqual({ kind: 'narrow', departmentId: 'dept-x' });
    expect(findOne).not.toHaveBeenCalled();
  });

  it.each([OWNER_MODULE.FARM, OWNER_MODULE.HYDROPONICS, OWNER_MODULE.SENSOR])(
    'lets the module %s replace the own-department narrowing: the module IS the scope',
    async (moduleCode) => {
      const { repository, findOne } = employeeRepository(null);

      const resolved = await resolveApprovalDepartment(repository, { ...request, moduleCode });

      expect(resolved).toEqual({ kind: 'narrow', departmentId: undefined });
      expect(findOne).not.toHaveBeenCalled();
    },
  );

  it('reads an explicit null module like an absent one: the Company view', async () => {
    const { repository } = employeeRepository({ id: approverId, departmentHrId: 'dept-1' });

    const resolved = await resolveApprovalDepartment(repository, { ...request, moduleCode: null });

    expect(resolved).toEqual({ kind: 'narrow', departmentId: 'dept-1' });
  });

  it('never narrows a tenant admin implicitly', async () => {
    const { repository, findOne } = employeeRepository(null);

    const resolved = await resolveApprovalDepartment(repository, {
      ...request,
      narrowToOwnDepartment: false,
    });

    expect(resolved).toEqual({ kind: 'narrow', departmentId: undefined });
    expect(findOne).not.toHaveBeenCalled();
  });

  it('never narrows a viewer with no employee record', async () => {
    const { repository, findOne } = employeeRepository(null);

    const resolved = await resolveApprovalDepartment(repository, { ...request, approverId: null });

    expect(resolved).toEqual({ kind: 'narrow', departmentId: undefined });
    expect(findOne).not.toHaveBeenCalled();
  });

  it('lists everything for an approver placed in no department', async () => {
    const { repository } = employeeRepository({ id: approverId, departmentHrId: null });

    expect(await resolveApprovalDepartment(repository, request)).toEqual({
      kind: 'narrow',
      departmentId: null,
    });
  });

  it('reports an approver who is not an employee of the tenant, so the queue is empty rather than wide', async () => {
    const { repository } = employeeRepository(null);

    expect(await resolveApprovalDepartment(repository, request)).toEqual({
      kind: 'unknown-approver',
    });
  });
});

describe('applyApprovalDepartment', () => {
  const queryBuilder = (): { builder: SelectQueryBuilder<object>; andWhere: jest.Mock } => {
    const andWhere = jest.fn();
    // Only andWhere is reachable from applyApprovalDepartment; the double is declared as a Partial
    // so a single assertion hands it over as the builder.
    const partial: Partial<SelectQueryBuilder<object>> = { andWhere };
    andWhere.mockReturnValue(partial);
    return { builder: partial as SelectQueryBuilder<object>, andWhere };
  };

  it("filters through the employee's LIVE department, under the alias the builder uses", () => {
    const { builder, andWhere } = queryBuilder();

    applyApprovalDepartment(builder, 'employee', 'dept-1');

    expect(andWhere).toHaveBeenCalledWith('employee.departmentHrId = :departmentId', {
      departmentId: 'dept-1',
    });
  });

  it.each([undefined, null])('leaves the query untouched for %s', (departmentId) => {
    const { builder, andWhere } = queryBuilder();

    applyApprovalDepartment(builder, 'employee', departmentId);

    expect(andWhere).not.toHaveBeenCalled();
  });
});
