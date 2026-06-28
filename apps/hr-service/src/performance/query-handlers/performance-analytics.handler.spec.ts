/**
 * WHY THIS FILE EXISTS:
 * Backends for the FE analytics queries that 400'd before they existed
 * (GraphQL FE↔backend drift — FE shipped ahead of backend):
 *   - GetTeamPerformanceOverview  -> GetTeamPerformanceOverviewHandler
 *   - GetDepartmentKPIs           -> GetDepartmentKPIsHandler
 *   - GetReviewCycleStatus        -> GetReviewCycleStatusHandler
 *   - GetGoalProgressTrend        -> GetGoalProgressTrendHandler
 *
 * Each handler is read-only and computes its result from existing performance +
 * HR entities. Tests cover: happy-path aggregation, an empty/validation path,
 * and tenant-scoping (tenantId is propagated into every repository query so a
 * different tenant's rows can never be aggregated in).
 */
import { BadRequestException } from '@nestjs/common';
import { Repository } from 'typeorm';

import { GetTeamPerformanceOverviewHandler } from './get-team-performance-overview.handler';
import { GetTeamPerformanceOverviewQuery } from '../queries/get-team-performance-overview.query';
import { GetDepartmentKPIsHandler } from './get-department-kpis.handler';
import { GetDepartmentKPIsQuery } from '../queries/get-department-kpis.query';
import { GetReviewCycleStatusHandler } from './get-review-cycle-status.handler';
import { GetReviewCycleStatusQuery } from '../queries/get-review-cycle-status.query';
import { GetGoalProgressTrendHandler } from './get-goal-progress-trend.handler';
import { GetGoalProgressTrendQuery } from '../queries/get-goal-progress-trend.query';

import { PerformanceReview, ReviewStatus, ReviewPeriodType } from '../entities/performance-review.entity';
import { Goal, GoalStatus } from '../entities/goal.entity';
import { EmployeeKPI } from '../entities/kpi.entity';
import { Employee } from '../../hr/entities/employee.entity';
import { DepartmentHR } from '../../hr/entities/department.entity';

const tenantId = 'tenant-uuid-001';
const departmentId = 'dept-uuid-001';

/** Build a chainable QueryBuilder mock that captures bound params and yields rows. */
const buildQb = <T>(rows: T[]) => {
  const params: Record<string, unknown> = {};
  const qb = {
    where: jest.fn().mockImplementation((_c: string, p?: Record<string, unknown>) => {
      Object.assign(params, p);
      return qb;
    }),
    andWhere: jest.fn().mockImplementation((_c: string, p?: Record<string, unknown>) => {
      Object.assign(params, p);
      return qb;
    }),
    orderBy: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue(rows),
  };
  return { qb, params };
};

const employee = (id: string, overrides: Partial<Employee> = {}): Employee => {
  const e = new Employee();
  Object.assign(e, {
    id,
    tenantId,
    firstName: 'First',
    lastName: id,
    departmentHrId: departmentId,
    isDeleted: false,
    ...overrides,
  });
  return e;
};

const review = (overrides: Partial<PerformanceReview>): PerformanceReview => {
  const r = new PerformanceReview();
  Object.assign(r, {
    tenantId,
    isDeleted: false,
    periodType: ReviewPeriodType.ANNUAL,
    status: ReviewStatus.DRAFT,
    ...overrides,
  });
  return r;
};

// ============================================================================
describe('GetTeamPerformanceOverviewHandler', () => {
  beforeEach(() => jest.clearAllMocks());

  const build = (deps: {
    department: DepartmentHR | null;
    employees: Employee[];
    reviews: PerformanceReview[];
  }) => {
    const reviewQb = buildQb(deps.reviews);
    const reviewRepo: Partial<Repository<PerformanceReview>> = {
      createQueryBuilder: jest.fn().mockReturnValue(reviewQb.qb),
    };
    const empParams: Record<string, unknown> = {};
    const employeeRepo: Partial<Repository<Employee>> = {
      find: jest.fn().mockImplementation((opts: { where: Record<string, unknown> }) => {
        Object.assign(empParams, opts.where);
        return Promise.resolve(deps.employees);
      }),
    };
    const departmentRepo: Partial<Repository<DepartmentHR>> = {
      findOne: jest.fn().mockResolvedValue(deps.department),
    };
    const handler = new GetTeamPerformanceOverviewHandler(
      reviewRepo as Repository<PerformanceReview>,
      employeeRepo as Repository<Employee>,
      departmentRepo as Repository<DepartmentHR>,
    );
    return { handler, reviewParams: reviewQb.params, empParams };
  };

  it('aggregates completed/pending counts, average and leaderboards (happy path)', async () => {
    const dept = Object.assign(new DepartmentHR(), { id: departmentId, tenantId, name: 'Operations' });
    const emps = [employee('emp-A'), employee('emp-B'), employee('emp-C')];
    const reviews = [
      review({ employeeId: 'emp-A', status: ReviewStatus.FINALIZED, finalRating: 4.5, periodEnd: new Date('2026-01-31') }),
      review({ employeeId: 'emp-B', status: ReviewStatus.ACKNOWLEDGED, finalRating: 2.0, periodEnd: new Date('2026-01-31') }),
      review({ employeeId: 'emp-C', status: ReviewStatus.SELF_ASSESSMENT, finalRating: undefined, periodEnd: new Date('2026-01-31') }),
    ];
    const { handler } = build({ department: dept, employees: emps, reviews });

    const result = await handler.execute(new GetTeamPerformanceOverviewQuery(tenantId, departmentId));

    expect(result.departmentName).toBe('Operations');
    expect(result.totalEmployees).toBe(3);
    expect(result.reviewsCompleted).toBe(2); // FINALIZED + ACKNOWLEDGED
    expect(result.reviewsPending).toBe(1); // SELF_ASSESSMENT
    expect(result.averageRating).toBe(3.25); // (4.5 + 2.0) / 2
    expect(result.topPerformers[0]?.employee.id).toBe('emp-A');
    expect(result.needsAttention[0]?.employee.id).toBe('emp-B');
  });

  it('returns an empty overview when the department has no employees (empty path)', async () => {
    const { handler } = build({ department: null, employees: [], reviews: [] });

    const result = await handler.execute(new GetTeamPerformanceOverviewQuery(tenantId, departmentId));

    expect(result.totalEmployees).toBe(0);
    expect(result.averageRating).toBe(0);
    expect(result.topPerformers).toEqual([]);
    expect(result.departmentName).toBe('Unknown Department');
  });

  it('scopes employee + review queries to the calling tenant', async () => {
    const emps = [employee('emp-A')];
    const reviews = [review({ employeeId: 'emp-A', status: ReviewStatus.FINALIZED, finalRating: 3 })];
    const { handler, reviewParams, empParams } = build({
      department: null,
      employees: emps,
      reviews,
    });

    await handler.execute(new GetTeamPerformanceOverviewQuery(tenantId, departmentId));

    expect(empParams.tenantId).toBe(tenantId);
    expect(empParams.departmentHrId).toBe(departmentId);
    expect(reviewParams.tenantId).toBe(tenantId);
  });
});

// ============================================================================
describe('GetDepartmentKPIsHandler', () => {
  beforeEach(() => jest.clearAllMocks());

  const kpi = (overrides: Partial<EmployeeKPI>): EmployeeKPI => {
    const k = new EmployeeKPI();
    Object.assign(k, { tenantId, isDeleted: false, category: 'Safety', achievementPercent: 0, ...overrides });
    return k;
  };

  const build = (employees: Employee[], kpis: EmployeeKPI[]) => {
    const kpiQb = buildQb(kpis);
    const kpiRepo: Partial<Repository<EmployeeKPI>> = {
      createQueryBuilder: jest.fn().mockReturnValue(kpiQb.qb),
    };
    const employeeRepo: Partial<Repository<Employee>> = {
      find: jest.fn().mockResolvedValue(employees),
    };
    const handler = new GetDepartmentKPIsHandler(
      kpiRepo as Repository<EmployeeKPI>,
      employeeRepo as Repository<Employee>,
    );
    return { handler, kpiParams: kpiQb.params };
  };

  it('buckets KPIs by category and averages achievement (happy path)', async () => {
    const emps = [employee('emp-A'), employee('emp-B')];
    const kpis = [
      kpi({ employeeId: 'emp-A', category: 'Safety', achievementPercent: 80 }),
      kpi({ employeeId: 'emp-B', category: 'Safety', achievementPercent: 60 }),
      kpi({ employeeId: 'emp-A', category: 'Quality', achievementPercent: 90 }),
    ];
    const { handler } = build(emps, kpis);

    const result = await handler.execute(
      new GetDepartmentKPIsQuery(tenantId, departmentId, '2026-01-01', '2026-12-31'),
    );

    const safety = result.find((c) => c.category === 'Safety');
    const quality = result.find((c) => c.category === 'Quality');
    expect(safety?.averageAchievement).toBe(70); // (80 + 60) / 2
    expect(safety?.employees).toHaveLength(2);
    expect(quality?.averageAchievement).toBe(90);
  });

  it('throws BadRequestException when periodStart is after periodEnd (validation path)', async () => {
    const { handler } = build([employee('emp-A')], []);

    await expect(
      handler.execute(new GetDepartmentKPIsQuery(tenantId, departmentId, '2026-12-31', '2026-01-01')),
    ).rejects.toThrow(BadRequestException);
  });

  it('scopes the KPI query to the calling tenant', async () => {
    const { handler, kpiParams } = build([employee('emp-A')], []);

    await handler.execute(
      new GetDepartmentKPIsQuery(tenantId, departmentId, '2026-01-01', '2026-12-31'),
    );

    expect(kpiParams.tenantId).toBe(tenantId);
  });
});

// ============================================================================
describe('GetReviewCycleStatusHandler', () => {
  beforeEach(() => jest.clearAllMocks());

  const build = (totalEmployees: number, reviews: PerformanceReview[]) => {
    const reviewQb = buildQb(reviews);
    const reviewRepo: Partial<Repository<PerformanceReview>> = {
      createQueryBuilder: jest.fn().mockReturnValue(reviewQb.qb),
    };
    const employeeRepo: Partial<Repository<Employee>> = {
      count: jest.fn().mockResolvedValue(totalEmployees),
    };
    const handler = new GetReviewCycleStatusHandler(
      reviewRepo as Repository<PerformanceReview>,
      employeeRepo as Repository<Employee>,
    );
    return { handler, reviewParams: reviewQb.params };
  };

  it('buckets reviews by status and computes completion rate (happy path)', async () => {
    const reviews = [
      review({ employeeId: 'emp-A', status: ReviewStatus.FINALIZED }),
      review({ employeeId: 'emp-B', status: ReviewStatus.ACKNOWLEDGED }),
      review({ employeeId: 'emp-C', status: ReviewStatus.MANAGER_REVIEW }),
      review({ employeeId: 'emp-D', status: ReviewStatus.DRAFT }),
    ];
    const { handler } = build(5, reviews);

    const result = await handler.execute(
      new GetReviewCycleStatusQuery(tenantId, ReviewPeriodType.ANNUAL, 2026),
    );

    expect(result.totalEmployees).toBe(5);
    expect(result.finalized).toBe(1);
    expect(result.acknowledged).toBe(1);
    expect(result.managerReviewPending).toBe(1);
    // DRAFT (1) + employees with no review (5 - 4 = 1) = 2 not started
    expect(result.notStarted).toBe(2);
    // (finalized + acknowledged) / total = 2/5 = 40%
    expect(result.completionRate).toBe(40);
  });

  it('returns zeroed completion when there are no employees (empty path)', async () => {
    const { handler } = build(0, []);

    const result = await handler.execute(
      new GetReviewCycleStatusQuery(tenantId, ReviewPeriodType.QUARTERLY, 2026),
    );

    expect(result.totalEmployees).toBe(0);
    expect(result.completionRate).toBe(0);
    expect(result.notStarted).toBe(0);
  });

  it('scopes the review query to the calling tenant + cycle', async () => {
    const { handler, reviewParams } = build(1, []);

    await handler.execute(new GetReviewCycleStatusQuery(tenantId, ReviewPeriodType.ANNUAL, 2026));

    expect(reviewParams.tenantId).toBe(tenantId);
    expect(reviewParams.periodType).toBe(ReviewPeriodType.ANNUAL);
    expect(reviewParams.cycleStart).toBe('2026-01-01');
  });
});

// ============================================================================
describe('GetGoalProgressTrendHandler', () => {
  beforeEach(() => jest.clearAllMocks());

  const goal = (overrides: Partial<Goal>): Goal => {
    const g = new Goal();
    Object.assign(g, {
      tenantId,
      employeeId: 'emp-A',
      isDeleted: false,
      status: GoalStatus.IN_PROGRESS,
      progressPercent: 0,
      startDate: new Date('2026-01-01'),
      ...overrides,
    });
    return g;
  };

  const build = (goals: Goal[]) => {
    const goalQb = buildQb(goals);
    const goalRepo: Partial<Repository<Goal>> = {
      createQueryBuilder: jest.fn().mockReturnValue(goalQb.qb),
    };
    const handler = new GetGoalProgressTrendHandler(goalRepo as Repository<Goal>);
    return { handler, goalParams: goalQb.params };
  };

  it('produces monthly trend points with totals and average progress (happy path)', async () => {
    const goals = [
      goal({ progressPercent: 50, startDate: new Date('2026-01-01') }),
      goal({
        progressPercent: 100,
        status: GoalStatus.COMPLETED,
        startDate: new Date('2026-01-01'),
        completedDate: new Date('2026-02-15'),
      }),
    ];
    const { handler } = build(goals);

    const result = await handler.execute(
      new GetGoalProgressTrendQuery(tenantId, 'emp-A', '2026-01-01', '2026-03-31'),
    );

    // Jan, Feb, Mar boundaries
    expect(result).toHaveLength(3);
    const march = result[result.length - 1];
    expect(march?.totalGoals).toBe(2);
    expect(march?.completedGoals).toBe(1); // completed by Feb 15
    expect(march?.averageProgress).toBe(50); // only the still-active goal counts
  });

  it('throws BadRequestException when startDate is after endDate (validation path)', async () => {
    const { handler } = build([]);

    await expect(
      handler.execute(new GetGoalProgressTrendQuery(tenantId, 'emp-A', '2026-12-31', '2026-01-01')),
    ).rejects.toThrow(BadRequestException);
  });

  it('scopes the goal query to the calling tenant + employee', async () => {
    const { handler, goalParams } = build([]);

    await handler.execute(
      new GetGoalProgressTrendQuery(tenantId, 'emp-A', '2026-01-01', '2026-03-31'),
    );

    expect(goalParams.tenantId).toBe(tenantId);
    expect(goalParams.employeeId).toBe('emp-A');
  });
});
