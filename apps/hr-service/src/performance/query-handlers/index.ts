export * from './get-performance-reviews.handler';
export * from './get-performance-review.handler';
export * from './get-my-performance-reviews.handler';
export * from './get-pending-reviews.handler';
export * from './get-goals.handler';
export * from './get-goal.handler';
export * from './get-my-goals.handler';
export * from './get-employee-kpis.handler';
export * from './get-team-goals.handler';
export * from './get-overdue-goals.handler';
export * from './get-performance-summary.handler';
export * from './get-team-performance-overview.handler';
export * from './get-department-kpis.handler';
export * from './get-review-cycle-status.handler';
export * from './get-goal-progress-trend.handler';

import { GetPerformanceReviewsHandler } from './get-performance-reviews.handler';
import { GetPerformanceReviewHandler } from './get-performance-review.handler';
import { GetMyPerformanceReviewsHandler } from './get-my-performance-reviews.handler';
import { GetPendingReviewsHandler } from './get-pending-reviews.handler';
import { GetGoalsHandler } from './get-goals.handler';
import { GetGoalHandler } from './get-goal.handler';
import { GetMyGoalsHandler } from './get-my-goals.handler';
import { GetEmployeeKPIsHandler } from './get-employee-kpis.handler';
import { GetTeamGoalsHandler } from './get-team-goals.handler';
import { GetOverdueGoalsHandler } from './get-overdue-goals.handler';
import { GetPerformanceSummaryHandler } from './get-performance-summary.handler';
import { GetTeamPerformanceOverviewHandler } from './get-team-performance-overview.handler';
import { GetDepartmentKPIsHandler } from './get-department-kpis.handler';
import { GetReviewCycleStatusHandler } from './get-review-cycle-status.handler';
import { GetGoalProgressTrendHandler } from './get-goal-progress-trend.handler';

export const PerformanceQueryHandlers = [
  GetPerformanceReviewsHandler,
  GetPerformanceReviewHandler,
  GetMyPerformanceReviewsHandler,
  GetPendingReviewsHandler,
  GetGoalsHandler,
  GetGoalHandler,
  GetMyGoalsHandler,
  GetEmployeeKPIsHandler,
  GetTeamGoalsHandler,
  GetOverdueGoalsHandler,
  GetPerformanceSummaryHandler,
  GetTeamPerformanceOverviewHandler,
  GetDepartmentKPIsHandler,
  GetReviewCycleStatusHandler,
  GetGoalProgressTrendHandler,
];
