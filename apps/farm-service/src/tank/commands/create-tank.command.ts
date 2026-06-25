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
    /**
     * SSOT-C-13: tenant plan tier ordinal (PLAN_LEVEL) for per-plan pond/tank
     * count quota. Undefined for platform SUPER_ADMIN → quota skipped.
     */
    public readonly planLevel?: number,
  ) {}
}
