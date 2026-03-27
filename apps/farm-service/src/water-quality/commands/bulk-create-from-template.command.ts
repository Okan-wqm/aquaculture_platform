/**
 * BulkCreateFromTemplateCommand
 *
 * Sablondan toplu parametre konfigurasyonu olusturmak icin command.
 *
 * @module WaterQuality/Commands
 */
import { ITenantCommand } from '@platform/cqrs';

export class BulkCreateFromTemplateCommand implements ITenantCommand {
  readonly commandName = 'BulkCreateFromTemplateCommand';

  constructor(
    public readonly tenantId: string,
    public readonly templateId: string,
    public readonly overwrite: boolean,
    public readonly userId: string,
  ) {}
}
