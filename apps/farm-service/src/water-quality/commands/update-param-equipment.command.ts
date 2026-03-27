/**
 * UpdateParamEquipmentCommand
 *
 * Updates an existing parameter-equipment mapping.
 *
 * @module WaterQuality/Commands
 */
import { ITenantCommand } from '@platform/cqrs';

/**
 * Payload for updating a parameter-equipment mapping
 */
export interface UpdateParamEquipmentPayload {
  monitoringFrequency?: string;
  sensorId?: string;
  alertEnabled?: boolean;
  isActive?: boolean;
  notes?: string;
}

export class UpdateParamEquipmentCommand implements ITenantCommand {
  readonly commandName = 'UpdateParamEquipmentCommand';

  constructor(
    public readonly tenantId: string,
    public readonly mappingId: string,
    public readonly payload: UpdateParamEquipmentPayload,
    public readonly userId: string,
  ) {}
}
