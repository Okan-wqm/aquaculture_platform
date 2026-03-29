import { ICommand } from '@nestjs/cqrs';
import { UpdateChannelInput } from '../dto/update-channel.input';

/**
 * Command to update channel metadata (name, description, avatarUrl).
 */
export class UpdateChannelCommand implements ICommand {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly channelId: string,
    public readonly input: UpdateChannelInput,
  ) {}
}
