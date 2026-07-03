import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ObjectType, Field, Int, Float } from '@nestjs/graphql';
import { GetReviewCycleStatusQuery } from '../queries/get-review-cycle-status.query';
import { PerformanceReview, ReviewStatus } from '../entities/performance-review.entity';
import { Employee } from '../../hr/entities/employee.entity';

@ObjectType()
export class ReviewCycleStatus {
  @Field(() => Int)
  totalEmployees!: number;

  @Field(() => Int)
  notStarted!: number;

  @Field(() => Int)
  selfAssessmentPending!: number;

  @Field(() => Int)
  managerReviewPending!: number;

  @Field(() => Int)
  calibrationPending!: number;

  @Field(() => Int)
  finalized!: number;

  @Field(() => Int)
  acknowledged!: number;

  @Field(() => Float)
  completionRate!: number;
}

/**
 * WHY THIS FILE EXISTS:
 * Backend for the FE `GetReviewCycleStatus` query (performance.operations.ts).
 * The query 400'd before this handler existed (FE shipped ahead of backend).
 * Buckets the existing PerformanceReview rows of one review cycle (periodType +
 * calendar year of periodStart) by status, and counts employees with no review
 * yet as notStarted — no new persistence introduced.
 *
 * Tenant isolation: both the review query and the employee count are scoped by
 * tenantId so cross-tenant cycle data can never be observed.
 */
@QueryHandler(GetReviewCycleStatusQuery)
export class GetReviewCycleStatusHandler implements IQueryHandler<GetReviewCycleStatusQuery> {
  constructor(
    @InjectRepository(PerformanceReview)
    private readonly reviewRepository: Repository<PerformanceReview>,
    @InjectRepository(Employee)
    private readonly employeeRepository: Repository<Employee>,
  ) {}

  async execute(query: GetReviewCycleStatusQuery): Promise<ReviewCycleStatus> {
    const { tenantId, periodType, year } = query;

    // Total headcount the cycle is measured against (active, non-deleted).
    const totalEmployees = await this.employeeRepository.count({
      where: { tenantId, isDeleted: false },
    });

    // Reviews for this cycle: same periodType and a periodStart inside the
    // requested calendar year.
    const cycleStart = `${year}-01-01`;
    const nextYearStart = `${year + 1}-01-01`;

    const reviews = await this.reviewRepository
      .createQueryBuilder('r')
      .where('r.tenantId = :tenantId', { tenantId })
      .andWhere('r.periodType = :periodType', { periodType })
      .andWhere('r.isDeleted = false')
      .andWhere('r.periodStart >= :cycleStart', { cycleStart })
      .andWhere('r.periodStart < :nextYearStart', { nextYearStart })
      .getMany();

    let selfAssessmentPending = 0;
    let managerReviewPending = 0;
    let calibrationPending = 0;
    let finalized = 0;
    let acknowledged = 0;
    // DRAFT reviews exist but the cycle work hasn't begun — count as not-started
    // along with employees who have no review row at all.
    let draftCount = 0;

    const employeesWithReview = new Set<string>();

    for (const review of reviews) {
      employeesWithReview.add(review.employeeId);
      switch (review.status) {
        case ReviewStatus.DRAFT:
          draftCount += 1;
          break;
        case ReviewStatus.SELF_ASSESSMENT:
          selfAssessmentPending += 1;
          break;
        case ReviewStatus.MANAGER_REVIEW:
          managerReviewPending += 1;
          break;
        case ReviewStatus.CALIBRATION:
          calibrationPending += 1;
          break;
        case ReviewStatus.FINALIZED:
          finalized += 1;
          break;
        case ReviewStatus.ACKNOWLEDGED:
          acknowledged += 1;
          break;
      }
    }

    // Employees without any review for this cycle, plus DRAFT (not yet kicked off).
    const employeesWithoutReview = Math.max(totalEmployees - employeesWithReview.size, 0);
    const notStarted = employeesWithoutReview + draftCount;

    // A cycle is "complete" for an employee once their review is finalized or
    // acknowledged. Rate is against total headcount.
    const completionRate =
      totalEmployees > 0
        ? Math.round(((finalized + acknowledged) / totalEmployees) * 10000) / 100
        : 0;

    return {
      totalEmployees,
      notStarted,
      selfAssessmentPending,
      managerReviewPending,
      calibrationPending,
      finalized,
      acknowledged,
      completionRate,
    };
  }
}
