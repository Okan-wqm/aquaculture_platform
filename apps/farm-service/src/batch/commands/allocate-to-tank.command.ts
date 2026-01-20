/**
 * AllocateToTankCommand
 *
 * Batch'i bir tank'a dağıtır (stoklama).
 * Bir batch birden fazla tank'a dağıtılabilir.
 *
 * @module Batch/Commands
 */
import { ITenantCommand } from '@platform/cqrs';

export enum AllocationType {
  INITIAL_STOCKING = 'initial_stocking',   // İlk stoklama
  SPLIT = 'split',                          // Bölme
  TRANSFER_IN = 'transfer_in',              // Transfer (giriş)
  TRANSFER_OUT = 'transfer_out',            // Transfer (çıkış)
  GRADING = 'grading',                      // Grading sonrası
  HARVEST = 'harvest',                      // Hasat için
}

export interface AllocateToTankPayload {
  tankId: string;                // Hedef tank ID
  quantity: number;              // Dağıtılacak adet
  avgWeightG: number;            // Ortalama ağırlık (gram)
  allocationType: AllocationType;
  allocatedAt?: Date;            // Dağıtım tarihi (default: now)
  notes?: string;
}

export class AllocateToTankCommand implements ITenantCommand {
  constructor(
    public readonly tenantId: string,
    public readonly batchId: string,
    public readonly payload: AllocateToTankPayload,
    public readonly allocatedBy: string,
  ) {}
}
