/**
 * @module ArchiveChannelHandler
 * @description CQRS handler for ArchiveChannelCommand. Validates the caller
 * has OWNER or ADMIN role, sets isArchived=true, and emits a ChannelArchived
 * outbox event — all within a single database transaction.
 * @see ADR-012 section 3.4 (Channel CQRS)
 */
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Logger, ForbiddenException, NotFoundException } from '@nestjs/common';
import { DataSource, IsNull } from 'typeorm';

import { OutboxPublisher } from '@platform/outbox';
import { createBaseEvent, BaseEvent } from '@platform/event-contracts';
import { ArchiveChannelCommand } from './archive-channel.command';
import { Channel } from '../entities/channel.entity';
import { ChannelMember, ChannelMemberRole } from '../entities/channel-member.entity';

@CommandHandler(ArchiveChannelCommand)
export class ArchiveChannelHandler
  implements ICommandHandler<ArchiveChannelCommand, boolean>
{
  private readonly logger = new Logger(ArchiveChannelHandler.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  /**
   * Execute the archive channel command within a single transaction.
   * @returns `true` on success.
   * @throws ForbiddenException if user lacks OWNER/ADMIN role.
   * @throws NotFoundException if channel does not exist.
   */
  async execute(command: ArchiveChannelCommand): Promise<boolean> {
    const { tenantId, userId, channelId } = command;

    return this.dataSource.transaction(async (manager) => {
      // 1. Load channel
      const channel = await manager.findOne(Channel, {
        where: { id: channelId },
      });
      if (!channel) {
        throw new NotFoundException(`Channel ${channelId} not found`);
      }

      if (channel.isArchived) {
        return true; // Already archived — idempotent
      }

      // 2. Authorize: caller must be OWNER or ADMIN in this channel
      const membership = await manager.findOne(ChannelMember, {
        where: { channelId, userId, leftAt: IsNull() },
      });
      if (!membership) {
        throw new ForbiddenException('You are not a member of this channel');
      }

      const isPrivileged =
        membership.role === ChannelMemberRole.ADMIN ||
        membership.role === ChannelMemberRole.OWNER;

      if (!isPrivileged) {
        throw new ForbiddenException(
          'Only ADMIN or OWNER can archive a channel',
        );
      }

      // 3. Set archived flag
      channel.isArchived = true;
      await manager.save(Channel, channel);

      // 4. Emit outbox event
      await this.outboxPublisher.enqueue({
        ...createBaseEvent('ChannelArchived', tenantId),
        channelId,
        archivedBy: userId,
      },  manager);

      this.logger.log(`Channel ${channelId} archived by user ${userId}`);
      return true;
    });
  }
}
