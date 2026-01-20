/**
 * DeployCleanerFishCommand
 *
 * Cleaner fish'i bir production tank'ına yerleştirir.
 * Cleaner batch'ten belirtilen miktarı hedef tanka deploy eder.
 *
 * @module Batch/Commands
 */
import { ITenantCommand } from '@platform/cqrs';

export interface DeployCleanerFishPayload {
  cleanerBatchId: string;         // Cleaner fish batch ID
  targetTankId: string;           // Hedef tank ID (production batch'in olduğu tank)
  quantity: number;               // Deploy edilecek adet
  avgWeightG?: number;            // Ortalama ağırlık (opsiyonel, batch'ten alınır)
  deployedAt: Date;               // Deployment tarihi
  notes?: string;
}

export class DeployCleanerFishCommand implements ITenantCommand {
  constructor(
    public readonly tenantId: string,
    public readonly payload: DeployCleanerFishPayload,
    public readonly deployedBy: string,
  ) {}
}
