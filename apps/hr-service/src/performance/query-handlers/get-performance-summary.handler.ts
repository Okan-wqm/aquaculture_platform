import { numberOrUndefined } from '@aquaculture/backend-common/database';
import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { GetPerformanceSummaryQuery } from '../queries/get-performance-summary.query';
import { PerformanceReview } from '../entities/performance-review.entity';
import { Goal, GoalStatus } from '../entities/goal.entity';
import { EmployeeKPI } from '../entities/kpi.entity';
import { ObjectType, Field, ID, Float, Int } from '@nestjs/graphql';

@ObjectType()
export class ReviewSummaryItem {
  @Field(() => ID)
  id!: string;

  @Field({ nullable: true })
  status?: string;

  @Field({ nullable: true })
  periodType?: string;

  @Field({ nullable: true })
  periodStart?: string;

  @Field({ nullable: true })
  periodEnd?: string;

  @Field(() => Float, { nullable: true })
  finalRating?: number;
}

@ObjectType()
export class PerformanceSummary {
  @Field()
  employeeId!: string;

  @Field(() => ReviewSummaryItem, { nullable: true })
  currentReview?: ReviewSummaryItem;

  @Field(() => ReviewSummaryItem, { nullable: true })
  previousReview?: ReviewSummaryItem;

  @Field(() => Int)
  activeGoals!: number;

  @Field(() => Int)
  completedGoals!: number;

  @Field(() => Int)
  overdueGoals!: number;

  @Field(() => Float)
  averageGoalProgress!: number;

  @Field(() => Float)
  kpiAchievement!: number;

  @Field()
  ratingTrend!: string;
}

@QueryHandler(GetPerformanceSummaryQuery)
export class GetPerformanceSummaryHandler implements IQueryHandler<GetPerformanceSummaryQuery> {
  constructor(
    @InjectRepository(PerformanceReview)
    private readonly reviewRepository: Repository<PerformanceReview>,
    @InjectRepository(Goal)
    private readonly goalRepository: Repository<Goal>,
    @InjectRepository(EmployeeKPI)
    private readonly kpiRepository: Repository<EmployeeKPI>,
  ) {}

  async execute(query: GetPerformanceSummaryQuery): Promise<PerformanceSummary> {
    const { tenantId, employeeId } = query;

    // Get reviews ordered by period end
    const reviews = await this.reviewRepository.find({
      where: { tenantId, employeeId, isDeleted: false },
      order: { periodEnd: 'DESC' },
      take: 2,
    });

    const currentReview = reviews[0];
    const previousReview = reviews[1];

    // Get goal counts
    const goals = await this.goalRepository.find({
      where: { tenantId, employeeId, isDeleted: false },
    });

    const today = new Date();
    const activeGoals = goals.filter(
      (g) => g.status === GoalStatus.IN_PROGRESS || g.status === GoalStatus.NOT_STARTED,
    ).length;
    const completedGoals = goals.filter((g) => g.status === GoalStatus.COMPLETED).length;
    const overdueGoals = goals.filter(
      (g) =>
        (g.status === GoalStatus.IN_PROGRESS || g.status === GoalStatus.NOT_STARTED) &&
        new Date(g.targetDate) < today,
    ).length;

    // Calculate average goal progress for active goals
    const activeGoalsList = goals.filter(
      (g) => g.status === GoalStatus.IN_PROGRESS || g.status === GoalStatus.NOT_STARTED,
    );
    const averageGoalProgress =
      activeGoalsList.length > 0
        ? activeGoalsList.reduce((sum, g) => sum + Number(g.progressPercent), 0) / activeGoalsList.length
        : 0;

    // Get KPI achievement
    const kpis = await this.kpiRepository.find({
      where: { tenantId, employeeId, isDeleted: false },
    });
    const kpiAchievement =
      kpis.length > 0
        ? kpis.reduce((sum, k) => sum + Number(k.achievementPercent), 0) / kpis.length
        : 0;

    // Calculate rating trend
    let ratingTrend = 'stable';
    if (currentReview?.finalRating && previousReview?.finalRating) {
      const currentRating = Number(currentReview.finalRating);
      const previousRating = Number(previousReview.finalRating);
      if (currentRating > previousRating) {
        ratingTrend = 'improving';
      } else if (currentRating < previousRating) {
        ratingTrend = 'declining';
      }
    }

    const toSummaryItem = (review?: PerformanceReview): ReviewSummaryItem | undefined => {
      if (!review) return undefined;
      return {
        id: review.id,
        status: review.status,
        periodType: review.periodType,
        periodStart: review.periodStart?.toString(),
        periodEnd: review.periodEnd?.toString(),
        finalRating: numberOrUndefined(review.finalRating),
      };
    };

    return {
      employeeId,
      currentReview: toSummaryItem(currentReview),
      previousReview: toSummaryItem(previousReview),
      activeGoals,
      completedGoals,
      overdueGoals,
      averageGoalProgress: Math.round(averageGoalProgress * 100) / 100,
      kpiAchievement: Math.round(kpiAchievement * 100) / 100,
      ratingTrend,
    };
  }
}
