/**
 * Delete Tank Command
 * @module Tank/Commands
 */
import { ICommand } from '@platform/cqrs';

export class DeleteTankCommand implements ICommand {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly id: string,
  ) {}
}
