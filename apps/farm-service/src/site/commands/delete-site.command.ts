/**
 * Delete Site Command
 */
import { ICommand } from '@nestjs/cqrs';

export class DeleteSiteCommand implements ICommand {
  constructor(
    public readonly siteId: string,
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly cascade: boolean = false,
  ) {}
}
