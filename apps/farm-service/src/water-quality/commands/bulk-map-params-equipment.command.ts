/**
 * BulkMapParamsEquipmentCommand
 *
 * Maps multiple water quality parameters to a single equipment item.
 *
 * @module WaterQuality/Commands
 */
import { ITenantCommand } from '@platform/cqrs';

import type { MonitoringFrequency } from '../entities/water-quality-param-equipment.entity';

/**
 * Payload for bulk-mapping parameters to equipment
 */
export interface BulkMapParamsEquipmentPayload {
  equipmentId: string;
  parameterConfigIds: string[];
  monitoringFrequency?: MonitoringFrequency;
}

export class BulkMapParamsEquipmentCommand implements ITenantCommand {
  readonly commandName = 'BulkMapParamsEquipmentCommand';

  constructor(
    public readonly tenantId: string,
    public readonly payload: BulkMapParamsEquipmentPayload,
    public readonly userId: string,
  ) {}
}
