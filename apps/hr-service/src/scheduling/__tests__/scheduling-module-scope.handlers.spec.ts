/**
 * Scheduling queries — module scope.
 *
 * A module's Shift schedule lists only the people whose live department
 * belongs to that module. Each handler asks for that through the one
 * predicate in common/module-scope.ts; these specs pin that the scope is
 * applied when a module is given, absent when not (the Company view), and
 * that it only ever NARROWS the tenant-scoped query: the tenant predicate
 * stays and the scope adds an INNER JOIN, never a replacement of it.
 */
import type { Repository } from 'typeorm';

import { HrModuleCode } from '../../common/enums';
import type { Employee } from '../../hr/entities/employee.entity';
import type { WeeklyPlan } from '../entities/weekly-plan.entity';
import { GetOvertimeSummaryQuery } from '../queries/get-overtime-summary.query';
import { GetTeamWeeklyOverviewQuery } from '../queries/get-team-weekly-overview.query';
import { GetWeeklyPlansQuery } from '../queries/get-weekly-plans.query';
import { GetOvertimeSummaryHandler } from '../query-handlers/get-overtime-summary.handler';
import { GetTeamWeeklyOverviewHandler } from '../query-handlers/get-team-weekly-overview.handler';
import { GetWeeklyPlansHandler } from '../query-handlers/get-weekly-plans.handler';

const tenantId = 'tenant-uuid-001';

type QueryBuilderDouble = Record<string, jest.Mock>;

/** A chainable query-builder double; `terminals` are the awaited ends of the chain. */
function queryBuilderDouble(terminals: Record<string, unknown>): QueryBuilderDouble {
  const queryBuilder: QueryBuilderDouble = {};
  for (const method of [
    'leftJoinAndSelect',
    'innerJoin',
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

describe('scheduling queries — module scope', () => {
  describe('GetTeamWeeklyOverviewHandler', () => {
    const run = async (
      query: GetTeamWeeklyOverviewQuery,
      employees: Array<Partial<Employee>> = [],
    ): Promise<{ employeeQb: QueryBuilderDouble; planQb: QueryBuilderDouble }> => {
      const employeeQb = queryBuilderDouble({ getMany: employees });
      const planQb = queryBuilderDouble({ getMany: [] });
      await new GetTeamWeeklyOverviewHandler(
        repositoryOf<WeeklyPlan>(planQb),
        repositoryOf<Employee>(employeeQb),
      ).execute(query);
      return { employeeQb, planQb };
    };

    it('lists only the employees of the module when one is given', async () => {
      const { employeeQb } = await run(
        new GetTeamWeeklyOverviewQuery(
          tenantId,
          '2026-10-19',
          undefined,
          undefined,
          HrModuleCode.FARM,
        ),
      );

      expect(employeeQb['where']).toHaveBeenCalledWith('e.tenantId = :tenantId', { tenantId });
      expectScopedTo(employeeQb, 'e', HrModuleCode.FARM);
    });

    it('plans only the scoped employees, so totals and day counts follow the module', async () => {
      const { planQb } = await run(
        new GetTeamWeeklyOverviewQuery(
          tenantId,
          '2026-10-19',
          undefined,
          undefined,
          HrModuleCode.SENSOR,
        ),
        [{ id: 'emp-1', firstName: 'Ada', lastName: 'Lovelace' }],
      );

      expect(planQb['andWhere']).toHaveBeenCalledWith('wp.employeeId IN (:...employeeIds)', {
        employeeIds: ['emp-1'],
      });
    });

    it('is untouched without a module (the Company view)', async () => {
      const { employeeQb } = await run(new GetTeamWeeklyOverviewQuery(tenantId, '2026-10-19'));

      expect(employeeQb['innerJoin']).not.toHaveBeenCalled();
    });
  });

  describe('GetWeeklyPlansHandler', () => {
    const run = async (query: GetWeeklyPlansQuery): Promise<QueryBuilderDouble> => {
      const planQb = queryBuilderDouble({ getManyAndCount: [[], 0] });
      await new GetWeeklyPlansHandler(
        repositoryOf<WeeklyPlan>(planQb),
        {} as Repository<Employee>,
      ).execute(query);
      return planQb;
    };

    it('lists only the plans of employees in the module when one is given', async () => {
      const planQb = await run(
        new GetWeeklyPlansQuery(
          tenantId,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          20,
          1,
          HrModuleCode.HYDROPONICS,
        ),
      );

      expect(planQb['where']).toHaveBeenCalledWith('wp.tenantId = :tenantId', { tenantId });
      expectScopedTo(planQb, 'employee', HrModuleCode.HYDROPONICS);
    });

    it('is untouched without a module (the Company view)', async () => {
      const planQb = await run(new GetWeeklyPlansQuery(tenantId));

      expect(planQb['innerJoin']).not.toHaveBeenCalled();
    });
  });

  describe('GetOvertimeSummaryHandler', () => {
    const run = async (query: GetOvertimeSummaryQuery): Promise<QueryBuilderDouble> => {
      const planQb = queryBuilderDouble({ getMany: [] });
      await new GetOvertimeSummaryHandler(repositoryOf<WeeklyPlan>(planQb)).execute(query);
      return planQb;
    };

    it('sums only the plans of employees in the module when one is given', async () => {
      const planQb = await run(
        new GetOvertimeSummaryQuery(tenantId, 10, 2026, undefined, undefined, HrModuleCode.FARM),
      );

      expect(planQb['where']).toHaveBeenCalledWith('wp.tenantId = :tenantId', { tenantId });
      expectScopedTo(planQb, 'employee', HrModuleCode.FARM);
    });

    it('is untouched without a module (the Company view)', async () => {
      const planQb = await run(new GetOvertimeSummaryQuery(tenantId, 10, 2026));

      expect(planQb['innerJoin']).not.toHaveBeenCalled();
    });
  });
});
