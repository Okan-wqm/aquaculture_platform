import { ICommand } from '@nestjs/cqrs';

/**
 * Command to mark messages as read up to a specific message in a channel.
 */
export class MarkReadCommand implements ICommand {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly channelId: string,
    public readonly messageId: string,
  ) {}
}
