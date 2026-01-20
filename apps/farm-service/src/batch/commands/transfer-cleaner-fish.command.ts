/**
 * TransferCleanerFishCommand
 *
 * Cleaner fish'i bir tanktan başka bir tanka transfer eder.
 * Kaynak tank'tan çıkarıp hedef tank'a ekler.
 *
 * @module Batch/Commands
 */
import { ITenantCommand } from '@platform/cqrs';

export interface TransferCleanerFishPayload {
  cleanerBatchId: string;         // Cleaner fish batch ID
  sourceTankId: string;           // Kaynak tank ID
  destinationTankId: string;      // Hedef tank ID
  quantity: number;               // Transfer edilecek adet
  transferredAt: Date;            // Transfer tarihi
  reason?: string;                // Transfer nedeni
  notes?: string;
}

export class TransferCleanerFishCommand implements ITenantCommand {
  constructor(
    public readonly tenantId: string,
    public readonly payload: TransferCleanerFishPayload,
    public readonly transferredBy: string,
  ) {}
}
