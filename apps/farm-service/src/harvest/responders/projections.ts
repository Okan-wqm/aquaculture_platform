/**
 * PURE projections for the harvest farm-AI responder (PR-4, Production
 * specialist). Covers the harvest-plan lists and plan statistics.
 *
 * Rules of the read-only namespace (see common/nats/ai-query-responder.ts):
 *  - Input = the query handler's return shape; output = wire DTO ONLY.
 *  - NO operator PII (approvedBy, createdBy, notes, attachments) and NO
 *    customer/commercial blobs (customerOrder, logistics destination) — the
 *    AI persona answers about fish and plans, never about people or buyers.
 *  - Dates → ISO strings (or null); numbers keep their unit in the name.
 */
import { HarvestPlan } from '../entities/harvest-plan.entity';
import { HarvestPlanStats } from '../services/harvest-plan.service';
import { isoOrNull } from '../../common/nats/ai-query-responder';

/** Harvest plan row (identity, schedule, estimates and actuals only). */
export interface HarvestPlanDto {
  id: string;
  planCode: string;
  name: string;
  batchId: string;
  status: string;
  harvestType: string;
  harvestMethod: string | null;
  productForm: string;
  plannedDate: string | null;
  confirmedDate: string | null;
  windowStartDate: string | null;
  windowEndDate: string | null;
  criteria: {
    targetWeightMinG: number | null;
    targetWeightMaxG: number | null;
    targetWeightG: number | null;
    targetQuantity: number | null;
    qualityGrade: string | null;
  };
  estimates: {
    estimatedQuantity: number;
    estimatedBiomassKg: number;
    estimatedAvgWeightG: number;
    estimatedYieldPercent: number;
    confidenceLevel: string;
  };
  actualQuantityHarvested: number | null;
  actualBiomassHarvestedKg: number | null;
  actualAvgWeightG: number | null;
}

/**
 * Project a harvest-plan row. Strips approver/creator identity, free-text
 * notes/attachments and the financial/logistics/customer JSONB blocks.
 */
export function projectHarvestPlan(plan: HarvestPlan): HarvestPlanDto {
  return {
    id: plan.id,
    planCode: plan.planCode,
    name: plan.name,
    batchId: plan.batchId,
    status: String(plan.status),
    harvestType: String(plan.harvestType),
    harvestMethod: plan.harvestMethod ? String(plan.harvestMethod) : null,
    productForm: String(plan.productForm),
    plannedDate: isoOrNull(plan.plannedDate),
    confirmedDate: isoOrNull(plan.confirmedDate),
    windowStartDate: isoOrNull(plan.windowStartDate),
    windowEndDate: isoOrNull(plan.windowEndDate),
    criteria: {
      targetWeightMinG: plan.criteria?.targetWeight?.min ?? null,
      targetWeightMaxG: plan.criteria?.targetWeight?.max ?? null,
      targetWeightG: plan.criteria?.targetWeight?.target ?? null,
      targetQuantity: plan.criteria?.targetQuantity?.value ?? null,
      qualityGrade: plan.criteria?.qualityGrade ?? null,
    },
    estimates: {
      estimatedQuantity: plan.estimates?.estimatedQuantity ?? 0,
      estimatedBiomassKg: plan.estimates?.estimatedBiomass ?? 0,
      estimatedAvgWeightG: plan.estimates?.estimatedAvgWeight ?? 0,
      estimatedYieldPercent: plan.estimates?.estimatedYield ?? 0,
      confidenceLevel: String(plan.estimates?.confidenceLevel ?? 'low'),
    },
    actualQuantityHarvested: plan.actualQuantityHarvested ?? null,
    actualBiomassHarvestedKg: plan.actualBiomassHarvested ?? null,
    actualAvgWeightG: plan.actualAvgWeight ?? null,
  };
}

/** Harvest plan counters — plain pass-through (no PII in the aggregate). */
export interface HarvestPlanStatsDto {
  total: number;
  draft: number;
  planned: number;
  approved: number;
  scheduled: number;
  inProgress: number;
  completed: number;
  cancelled: number;
  postponed: number;
  totalEstimatedBiomass: number;
  totalActualBiomass: number;
  upcomingCount: number;
  overdueCount: number;
}

/** Project the harvest-plan statistics aggregate. */
export function projectHarvestPlanStats(stats: HarvestPlanStats): HarvestPlanStatsDto {
  return { ...stats };
}
