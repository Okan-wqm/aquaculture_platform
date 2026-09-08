/**
 * UpdateHarvestRecordCommand
 *
 * Command for updating an existing harvest record.
 *
 * @module Harvest/Commands
 */
import { HarvestRecordStatus, QualityClass } from '../entities/harvest-record.entity';
import { HarvestMethod, ProductForm } from '../entities/harvest-plan.entity';

/**
 * Harvested quantity, biomass and average weight are deliberately absent
 * (FARM-CRITICAL-322). They are stock-bearing: the create path moves batch
 * aggregates, tank composition, tank biomass, the tank_operations ledger and
 * the farm-stock projection when it writes them. An edit that re-wrote them
 * here moved none of it. A correction is cancel + re-create, which reverses and
 * re-applies through the paths that already own those writes.
 */
export interface UpdateHarvestRecordData {
  status?: HarvestRecordStatus;
  /** Norwegian quality class — the stored SSoT (RPT-007). */
  qualityClass?: QualityClass;
  method?: HarvestMethod;
  productForm?: ProductForm;
  totalRevenue?: number;
  harvestCost?: number;
  currency?: string;
  mortalityDuringHarvest?: number;
  rejectedQuantity?: number;
  rejectionReason?: string;
  notes?: string;
}

export class UpdateHarvestRecordCommand {
  constructor(
    public readonly tenantId: string,
    public readonly harvestRecordId: string,
    public readonly data: UpdateHarvestRecordData,
    public readonly updatedBy: string,
  ) {}
}
