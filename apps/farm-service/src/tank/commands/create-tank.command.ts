/**
 * Create Tank Command
 * @module Tank/Commands
 */
import { ICommand } from '@platform/cqrs';
import { CreateTankInput } from '../dto/create-tank.dto';

export class CreateTankCommand implements ICommand {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly input: CreateTankInput,
  ) {}
}
