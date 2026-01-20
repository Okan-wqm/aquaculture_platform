/**
 * RecordCleanerMortalityCommand
 *
 * Cleaner fish mortality (ölüm) kaydı oluşturur.
 * Tank'taki cleaner fish miktarını düşürür.
 *
 * @module Batch/Commands
 */
import { ITenantCommand } from '@platform/cqrs';

export interface RecordCleanerMortalityPayload {
  cleanerBatchId: string;         // Cleaner fish batch ID
  tankId: string;                 // Tank ID (cleaner fish'in bulunduğu tank)
  quantity: number;               // Ölen adet
  reason: string;                 // Ölüm nedeni (MortalityReason enum value)
  detail?: string;                // Detaylı açıklama
  observedAt: Date;               // Gözlem tarihi
  notes?: string;
}

export class RecordCleanerMortalityCommand implements ITenantCommand {
  constructor(
    public readonly tenantId: string,
    public readonly payload: RecordCleanerMortalityPayload,
    public readonly recordedBy: string,
  ) {}
}
