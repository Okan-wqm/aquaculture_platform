/**
 * ReorderParameterConfigsCommand
 *
 * Parametre konfigurasyonlarinin siralama duzeni degistirmek icin command.
 *
 * @module WaterQuality/Commands
 */
import { ITenantCommand } from '@platform/cqrs';

export class ReorderParameterConfigsCommand implements ITenantCommand {
  readonly commandName = 'ReorderParameterConfigsCommand';

  constructor(
    public readonly tenantId: string,
    public readonly orderedIds: string[],
  ) {}
}
