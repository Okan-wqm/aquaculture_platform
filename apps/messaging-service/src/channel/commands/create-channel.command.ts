import { ICommand } from '@platform/cqrs';
import { CreateChannelInput } from '../dto/create-channel.input';

/**
 * Command to create a new messaging channel (GROUP, DIRECT, or AI).
 */
export class CreateChannelCommand implements ICommand {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly input: CreateChannelInput,
    /** Platform role: MODULE_USER, MODULE_MANAGER, TENANT_ADMIN, SUPER_ADMIN */
    public readonly userRole: string,
  ) {}
}
