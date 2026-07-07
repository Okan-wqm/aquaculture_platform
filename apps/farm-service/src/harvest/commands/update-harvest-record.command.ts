/**
 * UpdateHarvestRecordCommand
 *
 * Command for updating an existing harvest record.
 *
 * @module Harvest/Commands
 */
import { HarvestRecordStatus, QualityClass, QualityGrade } from '../entities/harvest-record.entity';
import { HarvestMethod, ProductForm } from '../entities/harvest-plan.entity';

export interface UpdateHarvestRecordData {
  status?: HarvestRecordStatus;
  quantityHarvested?: number;
  totalBiomass?: number;
  averageWeight?: number;
  /** Norwegian quality class — the stored SSoT (RPT-007). Preferred input. */
  qualityClass?: QualityClass;
  /** DEPRECATED legacy display grade — mapped onto qualityClass when supplied. */
  qualityGrade?: QualityGrade;
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
