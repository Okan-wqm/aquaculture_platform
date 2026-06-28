import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ObjectType, Field, ID, Int, Float } from '@nestjs/graphql';
import { GetTeamPerformanceOverviewQuery } from '../queries/get-team-performance-overview.query';
import { PerformanceReview, ReviewStatus } from '../entities/performance-review.entity';
import { Employee } from '../../hr/entities/employee.entity';
import { DepartmentHR } from '../../hr/entities/department.entity';

/**
 * A single employee + their latest finalized rating, used for the top-performer
 * and needs-attention leaderboards on the team-performance overview.
 */
@ObjectType()
export class EmployeePerformanceEntry {
  @Field(() => Employee)
  employee!: Employee;

  @Field(() => Float)
  rating!: number;
}

@ObjectType()
export class TeamPerformanceOverview {
  @Field(() => ID)
  departmentId!: string;

  @Field()
  departmentName!: string;

  @Field(() => Int)
  totalEmployees!: number;

  @Field(() => Int)
  reviewsCompleted!: number;

  @Field(() => Int)
  reviewsPending!: number;

  @Field(() => Float)
  averageRating!: number;

  @Field(() => [EmployeePerformanceEntry])
  topPerformers!: EmployeePerformanceEntry[];

  @Field(() => [EmployeePerformanceEntry])
  needsAttention!: EmployeePerformanceEntry[];
}

// A "completed" review is one that has reached a terminal, scored state.
const COMPLETED_STATUSES: ReviewStatus[] = [ReviewStatus.FINALIZED, ReviewStatus.ACKNOWLEDGED];

/**
 * WHY THIS FILE EXISTS:
 * Backend for the FE `GetTeamPerformanceOverview` query
 * (performance.operations.ts → useTeamPerformanceOverview). The query 400'd
 * before this handler existed (FE shipped ahead of backend). Computes a
 * department-level performance roll-up purely from existing performance + HR
 * entities — no new persistence introduced.
 *
 * `departmentId` is the HR department PK (Employee.departmentHrId / DepartmentHR.id),
 * consistent with get-overdue-goals.handler's department filter.
 *
 * Tenant isolation: every repository query is constrained by tenantId so a
 * department or its employees from another tenant can never be read.
 */
@QueryHandler(GetTeamPerformanceOverviewQuery)
export class GetTeamPerformanceOverviewHandler
  implements IQueryHandler<GetTeamPerformanceOverviewQuery>
{
  constructor(
    @InjectRepository(PerformanceReview)
    private readonly reviewRepository: Repository<PerformanceReview>,
    @InjectRepository(Employee)
    private readonly employeeRepository: Repository<Employee>,
    @InjectRepository(DepartmentHR)
    private readonly departmentRepository: Repository<DepartmentHR>,
  ) {}

  async execute(query: GetTeamPerformanceOverviewQuery): Promise<TeamPerformanceOverview> {
    const { tenantId, departmentId } = query;

    const department = await this.departmentRepository.findOne({
      where: { id: departmentId, tenantId, isDeleted: false },
    });

    // Members of the department (active employee records only).
    const employees = await this.employeeRepository.find({
      where: { tenantId, departmentHrId: departmentId, isDeleted: false },
    });

    const totalEmployees = employees.length;

    if (totalEmployees === 0) {
      return {
        departmentId,
        departmentName: department?.name ?? 'Unknown Department',
        totalEmployees: 0,
        reviewsCompleted: 0,
        reviewsPending: 0,
        averageRating: 0,
        topPerformers: [],
        needsAttention: [],
      };
    }

    const employeeIds = employees.map((e) => e.id);
    const employeeById = new Map(employees.map((e) => [e.id, e]));

    // All non-deleted reviews for the department's employees, newest first so
    // the first review seen per employee is their current one.
    const reviews = await this.reviewRepository
      .createQueryBuilder('r')
      .where('r.tenantId = :tenantId', { tenantId })
      .andWhere('r.employeeId IN (:...employeeIds)', { employeeIds })
      .andWhere('r.isDeleted = false')
      .orderBy('r.periodEnd', 'DESC')
      .getMany();

    let reviewsCompleted = 0;
    let reviewsPending = 0;
    const latestRatingByEmployee = new Map<string, number>();

    for (const review of reviews) {
      if (COMPLETED_STATUSES.includes(review.status)) {
        reviewsCompleted += 1;
      } else {
        reviewsPending += 1;
      }
      // First (latest) scored review per employee wins for the leaderboards.
      if (
        !latestRatingByEmployee.has(review.employeeId) &&
        review.finalRating !== null &&
        review.finalRating !== undefined
      ) {
        latestRatingByEmployee.set(review.employeeId, Number(review.finalRating));
      }
    }

    const ratedEntries: EmployeePerformanceEntry[] = [];
    for (const [employeeId, rating] of latestRatingByEmployee.entries()) {
      const employee = employeeById.get(employeeId);
      if (employee) {
        ratedEntries.push({ employee, rating });
      }
    }

    const averageRating =
      ratedEntries.length > 0
        ? Math.round(
            (ratedEntries.reduce((sum, e) => sum + e.rating, 0) / ratedEntries.length) * 100,
          ) / 100
        : 0;

    const sortedDesc = [...ratedEntries].sort((a, b) => b.rating - a.rating);
    const sortedAsc = [...ratedEntries].sort((a, b) => a.rating - b.rating);

    return {
      departmentId,
      departmentName: department?.name ?? 'Unknown Department',
      totalEmployees,
      reviewsCompleted,
      reviewsPending,
      averageRating,
      topPerformers: sortedDesc.slice(0, 5),
      needsAttention: sortedAsc.slice(0, 5),
    };
  }
}
