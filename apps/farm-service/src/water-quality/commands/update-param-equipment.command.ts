/**
 * UpdateParamEquipmentCommand
 *
 * Updates an existing parameter-equipment mapping.
 *
 * @module WaterQuality/Commands
 */
import { ITenantCommand } from '@platform/cqrs';

import type { MonitoringFrequency } from '../entities/water-quality-param-equipment.entity';

/**
 * Payload for updating a parameter-equipment mapping
 */
export interface UpdateParamEquipmentPayload {
  monitoringFrequency?: MonitoringFrequency;
  sensorId?: string | null;
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
