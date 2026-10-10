/**
 * CompleteHarvestPlanCommand
 *
 * Completes an IN_PROGRESS harvest plan with the counted results and moves
 * the harvested fish out of every tank holding the plan's batch — all in one
 * transaction (FARM-HIGH-394).
 *
 * @module Harvest/Commands
 */
import type { SiteScopeCaller } from '@aquaculture/backend-common/security';
import { ITenantCommand } from '@platform/cqrs';

import { QualityClass } from '../entities/harvest-record.entity';

export interface CompleteHarvestPlanActuals {
  /** Counted fish harvested (integer ≥ 1). */
  actualQuantity: number;
  /** Harvested biomass in kg (> 0). */
  actualBiomass: number;
  /** Average weight in grams (> 0). */
  actualAvgWeight: number;
  /** Norwegian quality class of the harvest — the stored SSoT (RPT-007). */
  qualityClass: QualityClass;
}

export class CompleteHarvestPlanCommand implements ITenantCommand {
  constructor(
    public readonly tenantId: string,
    public readonly planId: string,
    public readonly actuals: CompleteHarvestPlanActuals,
    /** The verified caller; its roles are re-checked against the permission matrix. */
    public readonly caller: SiteScopeCaller,
  ) {}
}
