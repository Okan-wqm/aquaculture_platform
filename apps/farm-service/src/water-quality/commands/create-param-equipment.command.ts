/**
 * CreateParamEquipmentCommand
 *
 * Links a water quality parameter to an equipment item.
 *
 * @module WaterQuality/Commands
 */
import { ITenantCommand } from '@platform/cqrs';

import type { MonitoringFrequency } from '../entities/water-quality-param-equipment.entity';

/**
 * Payload for creating a parameter-equipment mapping
 */
export interface CreateParamEquipmentPayload {
  parameterConfigId: string;
  equipmentId: string;
  monitoringFrequency?: MonitoringFrequency;
  sensorId?: string | null;
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
