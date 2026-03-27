/**
 * BulkMapParamsEquipmentCommand
 *
 * Maps multiple water quality parameters to a single equipment item.
 *
 * @module WaterQuality/Commands
 */
import { ITenantCommand } from '@platform/cqrs';

/**
 * Payload for bulk-mapping parameters to equipment
 */
export interface BulkMapParamsEquipmentPayload {
  equipmentId: string;
  parameterConfigIds: string[];
  monitoringFrequency?: string;
}

export class BulkMapParamsEquipmentCommand implements ITenantCommand {
  readonly commandName = 'BulkMapParamsEquipmentCommand';

  constructor(
    public readonly tenantId: string,
    public readonly payload: BulkMapParamsEquipmentPayload,
    public readonly userId: string,
  ) {}
}
