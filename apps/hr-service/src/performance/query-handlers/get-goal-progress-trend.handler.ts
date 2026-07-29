import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { toIsoCalendarDate } from '../../common/utc-calendar-date';
import { ObjectType, Field, Int, Float } from '@nestjs/graphql';
import { GetGoalProgressTrendQuery } from '../queries/get-goal-progress-trend.query';
import { Goal, GoalStatus } from '../entities/goal.entity';

@ObjectType()
export class GoalProgressTrendPoint {
  // ISO date (YYYY-MM-DD) of the bucket boundary (end of month within window).
  @Field()
  date!: string;

  @Field(() => Int)
  totalGoals!: number;

  @Field(() => Int)
  completedGoals!: number;

  @Field(() => Float)
  averageProgress!: number;
}

/**
 * WHY THIS FILE EXISTS:
 * Backend for the FE `GetGoalProgressTrend` query (performance.operations.ts).
 * The query 400'd before this handler existed (FE shipped ahead of backend).
 *
 * The trend is derived from columns that already exist on the Goal entity
 * (startDate, completedDate, status, progressPercent). There is NO per-day
 * progress-history table in the schema, so a faithful trend is produced as
 * MONTHLY buckets over [startDate, endDate] rather than fabricating daily
 * snapshots that were never recorded. For each bucket boundary we count:
 *   - totalGoals: goals that had started on/before the boundary and are not cancelled
 *   - completedGoals: goals with completedDate on/before the boundary
 *   - averageProgress: current progressPercent of the still-active goals in scope
 *     (progressPercent is the latest value; the schema does not retain history,
 *     which is documented here rather than invented).
 *
 * Tenant isolation: the goal query is constrained to the tenant + the requested
 * employee, so no cross-tenant or cross-employee data is reachable.
 */
@QueryHandler(GetGoalProgressTrendQuery)
export class GetGoalProgressTrendHandler implements IQueryHandler<GetGoalProgressTrendQuery> {
  constructor(
    @InjectRepository(Goal)
    private readonly goalRepository: Repository<Goal>,
  ) {}

  async execute(query: GetGoalProgressTrendQuery): Promise<GoalProgressTrendPoint[]> {
    const { tenantId, employeeId, startDate, endDate } = query;

    const windowStart = new Date(startDate);
    const windowEnd = new Date(endDate);

    if (Number.isNaN(windowStart.getTime()) || Number.isNaN(windowEnd.getTime())) {
      throw new BadRequestException('startDate and endDate must be valid ISO dates');
    }
    if (windowStart > windowEnd) {
      throw new BadRequestException('startDate must be on or before endDate');
    }

    // Pull every non-cancelled goal of this employee that could intersect the
    // window: it started on/before the window end.
    const goals = await this.goalRepository
      .createQueryBuilder('g')
      .where('g.tenantId = :tenantId', { tenantId })
      .andWhere('g.employeeId = :employeeId', { employeeId })
      .andWhere('g.isDeleted = false')
      .andWhere('g.status != :cancelled', { cancelled: GoalStatus.CANCELLED })
      .andWhere('g.startDate <= :windowEnd', { windowEnd: endDate })
      .getMany();

    const boundaries = this.monthEndBoundaries(windowStart, windowEnd);

    return boundaries.map((boundary) => {
      const inScope = goals.filter((g) => new Date(g.startDate) <= boundary);
      const completedGoals = inScope.filter(
        (g) =>
          g.status === GoalStatus.COMPLETED &&
          g.completedDate !== null &&
          g.completedDate !== undefined &&
          new Date(g.completedDate) <= boundary,
      ).length;

      // Average current progress of goals that were not yet completed at the
      // boundary (latest progressPercent — see file header on history).
      const activeAtBoundary = inScope.filter(
        (g) =>
          !(
            g.status === GoalStatus.COMPLETED &&
            g.completedDate !== null &&
            g.completedDate !== undefined &&
            new Date(g.completedDate) <= boundary
          ),
      );
      const averageProgress =
        activeAtBoundary.length > 0
          ? Math.round(
              (activeAtBoundary.reduce((sum, g) => sum + Number(g.progressPercent), 0) /
                activeAtBoundary.length) *
                100,
            ) / 100
          : 0;

      return {
        date: toIsoCalendarDate(boundary),
        totalGoals: inScope.length,
        completedGoals,
        averageProgress,
      };
    });
  }

  /**
   * Month-end boundaries within [start, end], inclusive of the window end.
   * E.g. start 2026-01-15, end 2026-03-10 -> [2026-01-31, 2026-02-28, 2026-03-10].
   */
  private monthEndBoundaries(start: Date, end: Date): Date[] {
    const boundaries: Date[] = [];
    let year = start.getUTCFullYear();
    let month = start.getUTCMonth();

    // Iterate month-by-month; clamp the final boundary to the window end.
    while (true) {
      // Last day of (year, month) at UTC midnight.
      const monthEnd = new Date(Date.UTC(year, month + 1, 0));
      if (monthEnd >= end) {
        boundaries.push(new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate())));
        break;
      }
      boundaries.push(monthEnd);
      month += 1;
      if (month > 11) {
        month = 0;
        year += 1;
      }
    }

    return boundaries;
  }
}
