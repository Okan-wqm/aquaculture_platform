import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GetOvertimeSummaryQuery } from '../queries/get-overtime-summary.query';
import { WeeklyPlan } from '../entities/weekly-plan.entity';
import { ObjectType, Field, Int, ID } from '@nestjs/graphql';

// Maximum employees to return in summary to prevent performance issues
const MAX_EMPLOYEES_IN_SUMMARY = 500;

@ObjectType()
export class EmployeeOvertimeSummary {
  @Field(() => ID)
  employeeId!: string;

  @Field()
  employeeName!: string;

  @Field(() => Int)
  plannedOvertimeMinutes!: number;

  @Field(() => Int)
  actualOvertimeMinutes!: number;

  @Field(() => Int)
  weekCount!: number;
}

@ObjectType()
export class OvertimeSummary {
  @Field(() => Int)
  month!: number;

  @Field(() => Int)
  year!: number;

  @Field(() => Int)
  totalPlannedOvertimeMinutes!: number;

  @Field(() => Int)
  totalActualOvertimeMinutes!: number;

  @Field(() => Int)
  employeeCount!: number;

  @Field(() => [EmployeeOvertimeSummary])
  byEmployee!: EmployeeOvertimeSummary[];
}

@QueryHandler(GetOvertimeSummaryQuery)
export class GetOvertimeSummaryHandler implements IQueryHandler<GetOvertimeSummaryQuery> {
  constructor(
    @InjectRepository(WeeklyPlan)
    private readonly planRepository: Repository<WeeklyPlan>,
  ) {}

  async execute(query: GetOvertimeSummaryQuery): Promise<OvertimeSummary> {
    const { tenantId, month, year, employeeId, departmentId } = query;

    // Calculate month date range
    const startOfMonth = new Date(year, month - 1, 1);
    const endOfMonth = new Date(year, month, 0);

    // Find all weekly plans that overlap with this month
    const qb = this.planRepository
      .createQueryBuilder('wp')
      .leftJoinAndSelect('wp.employee', 'employee')
      .where('wp.tenantId = :tenantId', { tenantId })
      .andWhere('wp.isDeleted = false')
      .andWhere('wp.weekStartDate <= :endOfMonth', { endOfMonth })
      .andWhere('wp.weekEndDate >= :startOfMonth', { startOfMonth });

    if (employeeId) {
      qb.andWhere('wp.employeeId = :employeeId', { employeeId });
    }

    if (departmentId) {
      qb.andWhere('employee.departmentHrId = :departmentId', { departmentId });
    }

    // Limit query results to prevent performance issues
    qb.take(MAX_EMPLOYEES_IN_SUMMARY * 4); // Multiply by 4 since each employee may have ~4 weeks per month

    const plans = await qb.getMany();

    // Aggregate by employee
    const employeeMap = new Map<string, {
      name: string;
      planned: number;
      actual: number;
      weeks: number;
    }>();

    for (const plan of plans) {
      const existing = employeeMap.get(plan.employeeId);
      const employeeName = plan.employee
        ? `${plan.employee.firstName} ${plan.employee.lastName}`
        : 'Unknown';

      if (existing) {
        existing.planned += plan.plannedOvertimeMinutes;
        existing.actual += plan.actualOvertimeMinutes;
        existing.weeks++;
      } else {
        employeeMap.set(plan.employeeId, {
          name: employeeName,
          planned: plan.plannedOvertimeMinutes,
          actual: plan.actualOvertimeMinutes,
          weeks: 1,
        });
      }
    }

    // Build response
    let totalPlanned = 0;
    let totalActual = 0;
    const byEmployee: EmployeeOvertimeSummary[] = [];

    for (const [empId, data] of employeeMap) {
      totalPlanned += data.planned;
      totalActual += data.actual;

      byEmployee.push({
        employeeId: empId,
        employeeName: data.name,
        plannedOvertimeMinutes: data.planned,
        actualOvertimeMinutes: data.actual,
        weekCount: data.weeks,
      });
    }

    // Sort by overtime descending
    byEmployee.sort((a, b) => b.plannedOvertimeMinutes - a.plannedOvertimeMinutes);

    return {
      month,
      year,
      totalPlannedOvertimeMinutes: totalPlanned,
      totalActualOvertimeMinutes: totalActual,
      employeeCount: employeeMap.size,
      byEmployee,
    };
  }
}
