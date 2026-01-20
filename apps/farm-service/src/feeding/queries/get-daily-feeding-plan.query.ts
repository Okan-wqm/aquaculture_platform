/**
 * GetDailyFeedingPlanQuery
 *
 * Belirli bir güne ait yemleme planını getirir.
 *
 * @module Feeding/Queries
 */
import { ITenantQuery } from '@platform/cqrs';

/**
 * Tank bazlı yemleme planı
 */
export interface TankFeedingPlan {
  tankId: string;
  tankCode: string;
  tankName: string;
  batchId: string;
  batchNumber: string;
  speciesName: string;
  currentQuantity: number;
  avgWeightG: number;
  biomassKg: number;
  feedId: string;
  feedName: string;
  plannedAmountKg: number;
  feedingRatePercent: number;
  mealsPerDay: number;
  amountPerMealKg: number;
  completedMeals: number;
  actualAmountTodayKg: number;
  remainingAmountKg: number;
}

/**
 * Günlük yemleme planı özeti
 */
export interface DailyFeedingPlanResult {
  date: Date;
  siteId: string;
  siteName: string;
  totalPlannedKg: number;
  totalActualKg: number;
  totalVarianceKg: number;
  variancePercent: number;
  completionPercent: number;
  tankPlans: TankFeedingPlan[];
}

export class GetDailyFeedingPlanQuery implements ITenantQuery {
  readonly queryName = 'GetDailyFeedingPlanQuery';

  constructor(
    public readonly tenantId: string,
    public readonly siteId: string,
    public readonly date: Date,
    public readonly departmentId?: string,
  ) {}
}
