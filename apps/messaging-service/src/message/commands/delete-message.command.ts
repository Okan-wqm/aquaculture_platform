import { ICommand } from '@nestjs/cqrs';

/**
 * Command to soft-delete a message.
 * Owner deletes own message; ADMIN/OWNER role can delete any message in channel.
 */
export class DeleteMessageCommand implements ICommand {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly messageId: string,
    /** Channel-level role of the requesting user (owner, admin, member) */
    public readonly channelRole: string | null,
  ) {}
}
