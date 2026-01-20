/**
 * Delete Species Command
 * @module Species/Commands
 */
import { ICommand } from '@platform/cqrs';

export class DeleteSpeciesCommand implements ICommand {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly id: string,
  ) {}
}
