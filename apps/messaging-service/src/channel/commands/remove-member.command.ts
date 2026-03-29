import { ICommand } from '@nestjs/cqrs';

/**
 * Command to remove a member from a channel (or self-leave).
 */
export class RemoveMemberCommand implements ICommand {
  constructor(
    public readonly tenantId: string,
    /** The user performing the action */
    public readonly actorUserId: string,
    public readonly channelId: string,
    /** The user to remove (same as actorUserId for self-leave) */
    public readonly targetUserId: string,
  ) {}
}
