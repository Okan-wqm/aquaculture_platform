/**
 * RemoveCleanerFishCommand
 *
 * Cleaner fish'i bir tank'tan çıkarır (harvest, cycle sonu, vb.).
 * Mortality değil, sağlıklı balıkların çıkarılması için kullanılır.
 *
 * @module Batch/Commands
 */
import { ITenantCommand } from '@platform/cqrs';

export type CleanerFishRemovalReason = 'end_of_cycle' | 'harvest' | 'relocation' | 'other';

export interface RemoveCleanerFishPayload {
  cleanerBatchId: string;           // Cleaner fish batch ID
  tankId: string;                   // Tank ID (cleaner fish'in olduğu tank)
  quantity: number;                 // Çıkarılacak adet
  reason: CleanerFishRemovalReason; // Çıkarma nedeni
  removedAt: Date;                  // Çıkarma tarihi
  avgWeightG?: number;              // Çıkarma anındaki ortalama ağırlık (harvest için)
  notes?: string;
}

export class RemoveCleanerFishCommand implements ITenantCommand {
  constructor(
    public readonly tenantId: string,
    public readonly payload: RemoveCleanerFishPayload,
    public readonly removedBy: string,
  ) {}
}
