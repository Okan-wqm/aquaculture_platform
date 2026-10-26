/**
 * Attendance queries — module scope.
 *
 * A module's Team › Today / Attendance pages list only the people whose live
 * department belongs to that module. Each handler asks for that through the
 * one predicate in common/module-scope.ts; these specs pin that the scope is
 * applied when a module is given, absent when not (the Company view), and
 * that it only ever NARROWS the tenant-scoped query: the tenant predicate
 * stays and the scope adds an INNER JOIN, never a replacement of it.
 */
import type { Repository } from 'typeorm';

import { HrModuleCode } from '../../common/enums';
import type { Employee } from '../../hr/entities/employee.entity';
import type { AttendanceRecord } from '../entities/attendance-record.entity';
import { GetAttendanceRecordsQuery } from '../queries/get-attendance-records.query';
import { GetDailyAttendanceOverviewQuery } from '../queries/get-daily-attendance-overview.query';
import { GetPendingAttendanceApprovalsQuery } from '../queries/get-pending-attendance-approvals.query';
import { GetTodaysAttendanceQuery } from '../queries/get-todays-attendance.query';
import { GetAttendanceRecordsHandler } from '../query-handlers/get-attendance-records.handler';
import { GetDailyAttendanceOverviewHandler } from '../query-handlers/get-daily-attendance-overview.handler';
import { GetPendingAttendanceApprovalsHandler } from '../query-handlers/get-pending-attendance-approvals.handler';
import { GetTodaysAttendanceHandler } from '../query-handlers/get-todays-attendance.handler';

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
    'select',
    'addSelect',
    'where',
    'andWhere',
    'orderBy',
    'addOrderBy',
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
  // Only createQueryBuilder is reachable from the handlers under test; the double is declared as a
  // Partial of the real repository so one plain assertion hands it over.
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

describe('attendance queries — module scope', () => {
  describe('GetTodaysAttendanceHandler', () => {
    const run = async (query: GetTodaysAttendanceQuery): Promise<QueryBuilderDouble> => {
      const queryBuilder = queryBuilderDouble({ getMany: [] });
      await new GetTodaysAttendanceHandler(repositoryOf<AttendanceRecord>(queryBuilder)).execute(
        query,
      );
      return queryBuilder;
    };

    it('lists only records of employees in the module when one is given', async () => {
      const queryBuilder = await run(
        new GetTodaysAttendanceQuery(tenantId, undefined, HrModuleCode.HYDROPONICS),
      );

      expectScopedTo(queryBuilder, 'employee', HrModuleCode.HYDROPONICS);
    });

    it('keeps the tenant predicate and the employee filter beside the scope', async () => {
      const queryBuilder = await run(
        new GetTodaysAttendanceQuery(tenantId, 'emp-1', HrModuleCode.FARM),
      );

      expect(queryBuilder['where']).toHaveBeenCalledWith('ar.tenantId = :tenantId', { tenantId });
      expect(queryBuilder['andWhere']).toHaveBeenCalledWith('ar.employeeId = :employeeId', {
        employeeId: 'emp-1',
      });
      expectScopedTo(queryBuilder, 'employee', HrModuleCode.FARM);
    });

    it('is untouched without a module (the Company view)', async () => {
      const queryBuilder = await run(new GetTodaysAttendanceQuery(tenantId));

      expect(queryBuilder['innerJoin']).not.toHaveBeenCalled();
    });
  });

  describe('GetAttendanceRecordsHandler', () => {
    const run = async (query: GetAttendanceRecordsQuery): Promise<QueryBuilderDouble> => {
      const queryBuilder = queryBuilderDouble({ getManyAndCount: [[], 0] });
      await new GetAttendanceRecordsHandler(repositoryOf<AttendanceRecord>(queryBuilder)).execute(
        query,
      );
      return queryBuilder;
    };

    it('lists only records of employees in the module when one is given', async () => {
      const queryBuilder = await run(
        new GetAttendanceRecordsQuery(
          tenantId,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          20,
          1,
          HrModuleCode.SENSOR,
        ),
      );

      expect(queryBuilder['where']).toHaveBeenCalledWith('ar.tenantId = :tenantId', { tenantId });
      expectScopedTo(queryBuilder, 'employee', HrModuleCode.SENSOR);
    });

    it('is untouched without a module (the Company view)', async () => {
      const queryBuilder = await run(new GetAttendanceRecordsQuery(tenantId));

      expect(queryBuilder['innerJoin']).not.toHaveBeenCalled();
    });
  });

  describe('GetPendingAttendanceApprovalsHandler', () => {
    let approverLookup: jest.Mock;
    const run = async (
      query: GetPendingAttendanceApprovalsQuery,
      approver: Partial<Employee> | null = { id: approverId, departmentHrId: 'dept-1' },
    ): Promise<QueryBuilderDouble> => {
      const queryBuilder = queryBuilderDouble({ getManyAndCount: [[], 0] });
      approverLookup = jest.fn().mockResolvedValue(approver);
      // The handler only calls findOne on the approver repository.
      const employeeRepository: Partial<Repository<Employee>> = { findOne: approverLookup };
      await new GetPendingAttendanceApprovalsHandler(
        repositoryOf<AttendanceRecord>(queryBuilder),
        employeeRepository as Repository<Employee>,
      ).execute(query);
      return queryBuilder;
    };
    const ownDepartmentNarrowing = [
      'employee.departmentHrId = :departmentId',
      expect.anything(),
    ] as const;

    it('lists only records of employees in the module when one is given', async () => {
      const queryBuilder = await run(
        new GetPendingAttendanceApprovalsQuery(
          tenantId,
          approverId,
          undefined,
          20,
          1,
          HrModuleCode.FARM,
        ),
      );

      expect(queryBuilder['where']).toHaveBeenCalledWith('ar.tenantId = :tenantId', { tenantId });
      expectScopedTo(queryBuilder, 'employee', HrModuleCode.FARM);
    });

    // The module IS the scope: an approver placed in a company-wide department must still see the
    // module's records, so the module replaces the own-department narrowing (as in the leave queue).
    it("lets the module replace the approver's own-department narrowing", async () => {
      const queryBuilder = await run(
        new GetPendingAttendanceApprovalsQuery(
          tenantId,
          approverId,
          undefined,
          20,
          1,
          HrModuleCode.SENSOR,
        ),
      );

      expect(queryBuilder['andWhere']).not.toHaveBeenCalledWith(...ownDepartmentNarrowing);
      expect(approverLookup).not.toHaveBeenCalled();
      expectScopedTo(queryBuilder, 'employee', HrModuleCode.SENSOR);
    });

    it('keeps an explicit department beside the module', async () => {
      const queryBuilder = await run(
        new GetPendingAttendanceApprovalsQuery(
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

    it('is untouched without a module (the Company view)', async () => {
      const queryBuilder = await run(new GetPendingAttendanceApprovalsQuery(tenantId, approverId));

      expect(queryBuilder['innerJoin']).not.toHaveBeenCalled();
    });

    describe('implicit own-department narrowing', () => {
      it("narrows a manager to their own department, looked up by the approver's EMPLOYEE id", async () => {
        const queryBuilder = await run(
          new GetPendingAttendanceApprovalsQuery(tenantId, approverId),
        );

        expect(approverLookup).toHaveBeenCalledWith(
          expect.objectContaining({ where: { id: approverId, tenantId, isDeleted: false } }),
        );
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
          new GetPendingAttendanceApprovalsQuery(
            tenantId,
            approverId,
            undefined,
            20,
            1,
            undefined,
            false,
          ),
        );

        expect(queryBuilder['andWhere']).not.toHaveBeenCalledWith(...ownDepartmentNarrowing);
        expect(approverLookup).not.toHaveBeenCalled();
        // The admin's own records still stay out of their own queue.
        expect(queryBuilder['andWhere']).toHaveBeenCalledWith('ar.employeeId != :approverId', {
          approverId,
        });
      });

      it('does not narrow when an explicit department is given, and does not look the approver up', async () => {
        const queryBuilder = await run(
          new GetPendingAttendanceApprovalsQuery(tenantId, approverId, 'dept-explicit'),
        );

        expect(approverLookup).not.toHaveBeenCalled();
        expect(queryBuilder['andWhere']).toHaveBeenCalledWith(
          'employee.departmentHrId = :departmentId',
          {
            departmentId: 'dept-explicit',
          },
        );
        expect(queryBuilder['andWhere']).not.toHaveBeenCalledWith(
          'employee.departmentHrId = :departmentId',
          {
            departmentId: 'dept-1',
          },
        );
      });

      it('returns an empty page, not every department, for an approver placed in none', async () => {
        const queryBuilder = await run(
          new GetPendingAttendanceApprovalsQuery(tenantId, approverId),
          {
            id: approverId,
            departmentHrId: null,
          },
        );

        expect(queryBuilder['getManyAndCount']).not.toHaveBeenCalled();
      });

      it('returns an empty page, not other departments, for an approver id that is no employee', async () => {
        const queryBuilder = await run(
          new GetPendingAttendanceApprovalsQuery(tenantId, approverId),
          null,
        );

        expect(queryBuilder['getManyAndCount']).not.toHaveBeenCalled();
      });

      // A manager with no employee record has no department to narrow to: an empty queue, never
      // the whole tenant's. Only a tenant admin (narrowToOwnDepartment false) works without one.
      it('returns an empty page for a manager without an employee record', async () => {
        const queryBuilder = await run(new GetPendingAttendanceApprovalsQuery(tenantId, null));

        expect(approverLookup).not.toHaveBeenCalled();
        expect(queryBuilder['getManyAndCount']).not.toHaveBeenCalled();
      });

      it('neither narrows nor excludes own records for a tenant admin without an employee record', async () => {
        const queryBuilder = await run(
          new GetPendingAttendanceApprovalsQuery(
            tenantId,
            null,
            undefined,
            20,
            1,
            undefined,
            false,
          ),
        );

        expect(approverLookup).not.toHaveBeenCalled();
        expect(queryBuilder['andWhere']).not.toHaveBeenCalledWith(...ownDepartmentNarrowing);
        expect(queryBuilder['andWhere']).not.toHaveBeenCalledWith(
          'ar.employeeId != :approverId',
          expect.anything(),
        );
        expect(queryBuilder['getManyAndCount']).toHaveBeenCalled();
      });

      it('scopes a viewer without an employee record to the module too', async () => {
        const queryBuilder = await run(
          new GetPendingAttendanceApprovalsQuery(
            tenantId,
            null,
            undefined,
            20,
            1,
            HrModuleCode.SENSOR,
          ),
        );

        expectScopedTo(queryBuilder, 'employee', HrModuleCode.SENSOR);
      });
    });
  });

  describe('GetDailyAttendanceOverviewHandler', () => {
    const stats = {
      presentCount: '70',
      lateCount: '10',
      onLeaveCount: '5',
      offshoreCount: '15',
      recordedCount: '85',
    };

    const run = async (
      query: GetDailyAttendanceOverviewQuery,
    ): Promise<{
      employees: QueryBuilderDouble;
      records: QueryBuilderDouble;
      overview: Awaited<ReturnType<GetDailyAttendanceOverviewHandler['execute']>>;
    }> => {
      const employees = queryBuilderDouble({ getCount: 100 });
      const records = queryBuilderDouble({ getRawOne: stats });
      const overview = await new GetDailyAttendanceOverviewHandler(
        repositoryOf<Employee>(employees),
        repositoryOf<AttendanceRecord>(records),
      ).execute(query);
      return { employees, records, overview };
    };

    it('counts the module employees and their attendance when a module is given', async () => {
      const { employees, records } = await run(
        new GetDailyAttendanceOverviewQuery(tenantId, '2026-03-08', HrModuleCode.FARM),
      );

      expectScopedTo(employees, 'employee', HrModuleCode.FARM);
      expectScopedTo(records, 'employee', HrModuleCode.FARM);
    });

    it('keeps both counts tenant-scoped beside the module scope', async () => {
      const { employees, records } = await run(
        new GetDailyAttendanceOverviewQuery(tenantId, '2026-03-08', HrModuleCode.HYDROPONICS),
      );

      expect(employees['where']).toHaveBeenCalledWith('employee.tenantId = :tenantId', {
        tenantId,
      });
      expect(records['where']).toHaveBeenCalledWith('ar.tenantId = :tenantId', { tenantId });
    });

    it('counts the whole tenant without a module (the Company view)', async () => {
      const { employees, records } = await run(
        new GetDailyAttendanceOverviewQuery(tenantId, '2026-03-08'),
      );

      expect(employees['innerJoin']).not.toHaveBeenCalled();
      expect(records['innerJoin']).not.toHaveBeenCalled();
    });

    it('derives absent and the rate from the scoped counts', async () => {
      const { overview } = await run(
        new GetDailyAttendanceOverviewQuery(tenantId, '2026-03-08', HrModuleCode.FARM),
      );

      expect(overview).toEqual({
        totalEmployees: 100,
        present: 70,
        late: 10,
        onLeave: 5,
        offshore: 15,
        absent: 15,
        attendanceRate: 80,
      });
    });
  });
});
