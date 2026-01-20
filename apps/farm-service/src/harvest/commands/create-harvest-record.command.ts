/**
 * CreateHarvestRecordCommand
 *
 * Hasat kaydı oluşturma komutu.
 * Frontend HarvestModal'dan gelen verileri işler.
 *
 * @module Harvest/Commands
 */
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
}

export class CreateHarvestRecordCommand {
  constructor(
    public readonly tenantId: string,
    public readonly input: CreateHarvestRecordInput,
    public readonly recordedBy: string,
  ) {}
}
