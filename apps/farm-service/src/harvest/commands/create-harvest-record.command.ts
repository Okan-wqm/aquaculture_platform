/**
 * CreateHarvestRecordCommand
 *
 * Hasat kaydı oluşturma komutu.
 * Frontend HarvestModal'dan gelen verileri işler.
 *
 * @module Harvest/Commands
 */
import type { MobileCommandEnvelope } from '@aquaculture/backend-common/mobile-command';

import { QualityGrade } from '../entities/harvest-record.entity';

export interface CreateHarvestRecordInput {
  batchId: string;
  tankId: string;
  quantityHarvested: number;
  averageWeight: number;
  totalBiomass: number;
  qualityGrade: QualityGrade | string;
  harvestDate: string | Date;
  pricePerKg?: number;
  buyerName?: string;
  notes?: string;
  /**
   * Optional for small harvests — made mandatory by
   * HarvestPolicyService when biomass > 10t or quantity > 50k
   * (thresholds env-overridable). When provided, the plan is
   * validated to be in an active status (APPROVED / SCHEDULED /
   * IN_PROGRESS) and bound to the same batch.
   */
  harvestPlanId?: string;
}

export class CreateHarvestRecordCommand {
  constructor(
    public readonly tenantId: string,
    public readonly input: CreateHarvestRecordInput,
    public readonly recordedBy: string,
    public readonly mobileCommand?: MobileCommandEnvelope,
  ) {}
}
