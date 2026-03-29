import { ICommand } from '@platform/cqrs';
import { ChannelMemberRole } from '../entities/channel-member.entity';

/**
 * Command to add a new member to an existing channel.
 */
export class AddMemberCommand implements ICommand {
  constructor(
    public readonly tenantId: string,
    /** The user performing the action */
    public readonly actorUserId: string,
    public readonly channelId: string,
    /** The user to add */
    public readonly targetUserId: string,
    /** The role to assign to the new member */
    public readonly role: ChannelMemberRole,
  ) {}
}
