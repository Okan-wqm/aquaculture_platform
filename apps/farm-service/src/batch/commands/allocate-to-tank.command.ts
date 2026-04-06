/**
 * AllocateToTankCommand
 *
 * Batch'i bir tank'a dağıtır (stoklama).
 * Bir batch birden fazla tank'a dağıtılabilir.
 *
 * @module Batch/Commands
 */
import { ITenantCommand } from '@platform/cqrs';
// IP-3: Single source of truth — AllocationType defined in entity, re-exported here
// WHY: Previously duplicated in both command and entity, causing double
// registerEnumType() calls which can crash the GraphQL schema builder.
export { AllocationType } from '../entities/tank-allocation.entity';

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
