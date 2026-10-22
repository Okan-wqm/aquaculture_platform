/**
 * Leave queries — module scope.
 *
 * A module's Leave requests page lists only the requests of people whose live
 * department belongs to that module. Each handler asks for that through the
 * one predicate in common/module-scope.ts; these specs pin that the scope is
 * applied when a module is given, absent when not (the Company view), and
 * that it only ever NARROWS the tenant-scoped query: the tenant predicate
 * stays and the scope adds an INNER JOIN beside it.
 *
 * The approver's own department is the IMPLICIT narrowing of the approval
 * queue. It is not stacked on a module: once a module is chosen, the module is
 * the scope (an approver in a company-wide department would otherwise see an
 * empty queue in every module), and a tenant admin is never narrowed implicitly.
 */
import type { Repository } from 'typeorm';

import { HrModuleCode } from '../../common/enums';
import type { Employee } from '../../hr/entities/employee.entity';
import type { LeaveRequest } from '../entities/leave-request.entity';
import { GetLeaveRequestsQuery } from '../queries/get-leave-requests.query';
import { GetPendingApprovalsQuery } from '../queries/get-pending-approvals.query';
import { GetTeamLeaveCalendarQuery } from '../queries/get-team-leave-calendar.query';
import { GetLeaveRequestsHandler } from '../query-handlers/get-leave-requests.handler';
import { GetPendingApprovalsHandler } from '../query-handlers/get-pending-approvals.handler';
import { GetTeamLeaveCalendarHandler } from '../query-handlers/get-team-leave-calendar.handler';

const tenantId = 'tenant-uuid-001';
const approverId = 'approver-uuid-001';

type QueryBuilderDouble = Record<string, jest.Mock>;

/** A chainable query-builder double; `terminals` are the awaited ends of the chain. */
function queryBuilderDouble(terminals: Record<string, unknown>): QueryBuilderDouble {
  const queryBuilder: QueryBuilderDouble = {};
  for (const method of [
    'leftJoin',
    'leftJoinAndSelect',
    'innerJoin',
    'addSelect',
    'where',
    'andWhere',
    'orderBy',
    'skip',
    'take',
  ]) {
    queryBuilder[method] = jest.fn(() => queryBuilder);
  }
  for (const [method, result] of Object.entries(terminals)) {
    queryBuilder[method] = jest.fn().mockResolvedValue(result);
  }
  return queryBuilder;
}

function repositoryOf<Entity extends object>(queryBuilder: QueryBuilderDouble): Repository<Entity> {
  // Only createQueryBuilder is reachable from these handlers; the double is declared as a
  // Partial so one plain assertion hands it over as the repository.
  const partial: Partial<Repository<Entity>> = {
    createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
  };
  return partial as Repository<Entity>;
}

/** The scope joins the employee's department under the given module and nothing else is asked of it. */
function expectScopedTo(
  queryBuilder: QueryBuilderDouble,
  employeeAlias: string,
  moduleCode: HrModuleCode,
): void {
  expect(queryBuilder['innerJoin']).toHaveBeenCalledTimes(1);
  expect(queryBuilder['innerJoin']).toHaveBeenCalledWith(
    `${employeeAlias}.departmentHr`,
    expect.any(String),
    expect.any(String),
    { scopeModuleCode: moduleCode },
  );
}

describe('leave queries — module scope', () => {
  describe('GetLeaveRequestsHandler', () => {
    const run = async (query: GetLeaveRequestsQuery): Promise<QueryBuilderDouble> => {
      const queryBuilder = queryBuilderDouble({ getManyAndCount: [[], 0] });
      await new GetLeaveRequestsHandler(repositoryOf<LeaveRequest>(queryBuilder)).execute(query);
      return queryBuilder;
    };

    it('lists only the requests of employees in the module when one is given', async () => {
      const queryBuilder = await run(
        new GetLeaveRequestsQuery(
          tenantId,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          20,
          1,
          HrModuleCode.FARM,
        ),
      );

      expect(queryBuilder['where']).toHaveBeenCalledWith('lr.tenantId = :tenantId', { tenantId });
      expectScopedTo(queryBuilder, 'employee', HrModuleCode.FARM);
    });

    it('is untouched without a module (the Company view)', async () => {
      const queryBuilder = await run(new GetLeaveRequestsQuery(tenantId));

      expect(queryBuilder['innerJoin']).not.toHaveBeenCalled();
    });
  });

  describe('GetPendingApprovalsHandler', () => {
    let approverLookup: jest.Mock;
    const run = async (
      query: GetPendingApprovalsQuery,
      approver: Partial<Employee> | null = { id: approverId, departmentHrId: 'dept-1' },
    ): Promise<QueryBuilderDouble> => {
      const queryBuilder = queryBuilderDouble({ getManyAndCount: [[], 0] });
      approverLookup = jest.fn().mockResolvedValue(approver);
      const employeeRepository: Partial<Repository<Employee>> = { findOne: approverLookup };
      await new GetPendingApprovalsHandler(
        repositoryOf<LeaveRequest>(queryBuilder),
        employeeRepository as Repository<Employee>,
      ).execute(query);
      return queryBuilder;
    };
    const ownDepartmentNarrowing = [
      'employee.departmentHrId = :departmentId',
      expect.anything(),
    ] as const;

    it('lists only the pending requests of employees in the module when one is given', async () => {
      const queryBuilder = await run(
        new GetPendingApprovalsQuery(
          tenantId,
          approverId,
          undefined,
          20,
          1,
          HrModuleCode.HYDROPONICS,
        ),
      );

      expect(queryBuilder['where']).toHaveBeenCalledWith('lr.tenantId = :tenantId', { tenantId });
      expectScopedTo(queryBuilder, 'employee', HrModuleCode.HYDROPONICS);
    });

    it("lets the module replace the approver's own-department narrowing", async () => {
      const queryBuilder = await run(
        new GetPendingApprovalsQuery(tenantId, approverId, undefined, 20, 1, HrModuleCode.FARM),
      );

      expect(queryBuilder['andWhere']).not.toHaveBeenCalledWith(...ownDepartmentNarrowing);
      expect(approverLookup).not.toHaveBeenCalled();
      expectScopedTo(queryBuilder, 'employee', HrModuleCode.FARM);
    });

    it('keeps an explicit department beside the module', async () => {
      const queryBuilder = await run(
        new GetPendingApprovalsQuery(
          tenantId,
          approverId,
          'dept-explicit',
          20,
          1,
          HrModuleCode.FARM,
        ),
      );

      expect(queryBuilder['andWhere']).toHaveBeenCalledWith(
        'employee.departmentHrId = :departmentId',
        {
          departmentId: 'dept-explicit',
        },
      );
      expectScopedTo(queryBuilder, 'employee', HrModuleCode.FARM);
    });

    it('narrows a manager to their own department in the Company view (no module, no department)', async () => {
      const queryBuilder = await run(new GetPendingApprovalsQuery(tenantId, approverId));

      expect(queryBuilder['andWhere']).toHaveBeenCalledWith(
        'employee.departmentHrId = :departmentId',
        {
          departmentId: 'dept-1',
        },
      );
      expect(queryBuilder['innerJoin']).not.toHaveBeenCalled();
    });

    it('never narrows a tenant admin implicitly, even one with an employee record', async () => {
      const queryBuilder = await run(
        new GetPendingApprovalsQuery(tenantId, approverId, undefined, 20, 1, undefined, false),
      );

      expect(queryBuilder['andWhere']).not.toHaveBeenCalledWith(...ownDepartmentNarrowing);
      expect(approverLookup).not.toHaveBeenCalled();
      // The admin's own requests still stay out of their own queue.
      expect(queryBuilder['andWhere']).toHaveBeenCalledWith('lr.employeeId != :approverId', {
        approverId,
      });
    });

    it('scopes an admin without an employee record to the module too', async () => {
      const queryBuilder = await run(
        new GetPendingApprovalsQuery(tenantId, null, undefined, 20, 1, HrModuleCode.SENSOR),
      );

      expectScopedTo(queryBuilder, 'employee', HrModuleCode.SENSOR);
    });

    it('is untouched without a module (the Company view)', async () => {
      const queryBuilder = await run(new GetPendingApprovalsQuery(tenantId, approverId));

      expect(queryBuilder['innerJoin']).not.toHaveBeenCalled();
    });
  });

  describe('GetTeamLeaveCalendarHandler', () => {
    const run = async (query: GetTeamLeaveCalendarQuery): Promise<QueryBuilderDouble> => {
      const queryBuilder = queryBuilderDouble({ getMany: [] });
      await new GetTeamLeaveCalendarHandler(repositoryOf<LeaveRequest>(queryBuilder)).execute(
        query,
      );
      return queryBuilder;
    };

    it('shows only the leave of employees in the module when one is given', async () => {
      const queryBuilder = await run(
        new GetTeamLeaveCalendarQuery(
          tenantId,
          undefined,
          '2026-10-22',
          '2026-10-22',
          HrModuleCode.FARM,
        ),
      );

      expect(queryBuilder['where']).toHaveBeenCalledWith('lr.tenantId = :tenantId', { tenantId });
      expectScopedTo(queryBuilder, 'employee', HrModuleCode.FARM);
    });

    it('is untouched without a module (the Company view)', async () => {
      const queryBuilder = await run(
        new GetTeamLeaveCalendarQuery(tenantId, undefined, '2026-10-22', '2026-10-22'),
      );

      expect(queryBuilder['innerJoin']).not.toHaveBeenCalled();
    });
  });
});
