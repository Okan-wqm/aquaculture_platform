/**
 * DeleteParamEquipmentCommand
 *
 * Removes a parameter-equipment mapping.
 *
 * @module WaterQuality/Commands
 */
import { ITenantCommand } from '@platform/cqrs';

export class DeleteParamEquipmentCommand implements ITenantCommand {
  readonly commandName = 'DeleteParamEquipmentCommand';

  constructor(
    public readonly tenantId: string,
    public readonly mappingId: string,
  ) {}
}
