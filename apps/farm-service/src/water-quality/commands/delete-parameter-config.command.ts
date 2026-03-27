/**
 * DeleteParameterConfigCommand
 *
 * Su kalitesi parametre konfigurasyonunu silmek icin command.
 *
 * @module WaterQuality/Commands
 */
import { ITenantCommand } from '@platform/cqrs';

export class DeleteParameterConfigCommand implements ITenantCommand {
  readonly commandName = 'DeleteParameterConfigCommand';

  constructor(
    public readonly tenantId: string,
    public readonly configId: string,
  ) {}
}
