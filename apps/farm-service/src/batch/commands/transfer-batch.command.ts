/**
 * TransferBatchCommand
 *
 * Batch'i bir tank'tan diğerine transfer eder.
 * Kaynak ve hedef tank'ların TankBatch durumlarını günceller.
 *
 * @module Batch/Commands
 */
import { ITenantCommand } from '@platform/cqrs';

export interface TransferBatchPayload {
  sourceTankId: string;          // Kaynak tank ID
  destinationTankId: string;     // Hedef tank ID
  quantity: number;              // Transfer edilecek adet
  avgWeightG?: number;           // Ortalama ağırlık (otomatik hesaplanabilir)
  transferReason?: string;       // Transfer nedeni
  transferredAt?: Date;          // Transfer tarihi (default: now)
  notes?: string;
  skipCapacityCheck?: boolean;   // Kapasite kontrolünü atla (aşırı yüklemeye izin ver)
}

export class TransferBatchCommand implements ITenantCommand {
  constructor(
    public readonly tenantId: string,
    public readonly batchId: string,
    public readonly payload: TransferBatchPayload,
    public readonly transferredBy: string,
  ) {}
}
