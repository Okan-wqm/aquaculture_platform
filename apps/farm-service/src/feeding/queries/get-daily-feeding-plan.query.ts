/**
 * GetDailyFeedingPlanQuery
 *
 * Fetches the daily feeding plan for a given site and date.
 * The result interface mirrors the GraphQL DailyFeedingPlanResponse type
 * so the resolver can return the handler result directly.
 *
 * @module Feeding/Queries
 */
import type { TenantScope } from '@aquaculture/backend-common/database';

/**
 * Individual planned feeding entry per equipment (tank/pond/cage).
 * Shape matches the GraphQL PlannedFeeding ObjectType exactly.
 */
export interface PlannedFeeding {
  batchId: string;
  batchCode: string;
  tankId?: string;
  tankCode?: string;
  feedId: string;
  feedName: string;
  plannedAmountKg: number;
  actualAmountKg: number;
  mealsPlanned: number;
  mealsCompleted: number;
  isComplete: boolean;
}

/**
 * Daily feeding plan summary.
 * Shape matches the GraphQL DailyFeedingPlanResponse ObjectType exactly.
 */
export interface DailyFeedingPlanResult {
  date: Date;
  siteId: string;
  plannedFeedings: PlannedFeeding[];
  totalPlannedKg: number;
  totalActualKg: number;
  completionPercent: number;
}

/**
 * Query to retrieve the daily feeding plan for a specific site and date.
 */
export class GetDailyFeedingPlanQuery {
  readonly queryName = 'GetDailyFeedingPlanQuery';

  constructor(
    public readonly scope: TenantScope,
    public readonly siteId: string,
    public readonly date: Date,
    public readonly departmentId?: string,
  ) {}
}
