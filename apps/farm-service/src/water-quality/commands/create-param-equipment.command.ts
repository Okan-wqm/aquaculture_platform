/**
 * CreateParamEquipmentCommand
 *
 * Links a water quality parameter to an equipment item.
 *
 * @module WaterQuality/Commands
 */
import { ITenantCommand } from '@platform/cqrs';

/**
 * Payload for creating a parameter-equipment mapping
 */
export interface CreateParamEquipmentPayload {
  parameterConfigId: string;
  equipmentId: string;
  monitoringFrequency?: string;
  sensorId?: string;
  alertEnabled?: boolean;
  notes?: string;
}

export class CreateParamEquipmentCommand implements ITenantCommand {
  readonly commandName = 'CreateParamEquipmentCommand';

  constructor(
    public readonly tenantId: string,
    public readonly payload: CreateParamEquipmentPayload,
    public readonly userId: string,
  ) {}
}
