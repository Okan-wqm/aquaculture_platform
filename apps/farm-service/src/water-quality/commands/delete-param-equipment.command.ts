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
    /** Who removed the plan line; recorded as its unboundBy. */
    public readonly userId: string,
  ) {}
}
