import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull } from 'typeorm';

import { Channel } from '../entities/channel.entity';
import { ChannelMember, ChannelMemberRole } from '../entities/channel-member.entity';

/**
 * Domain logic helper for channel operations.
 * Stateless service consumed by command handlers, query handlers, and other modules.
 */
@Injectable()
export class ChannelService {
  constructor(
    @InjectRepository(Channel)
    private readonly channelRepo: Repository<Channel>,
    @InjectRepository(ChannelMember)
    private readonly memberRepo: Repository<ChannelMember>,
  ) {}

  /**
   * Build a deterministic DM pair key from two user UUIDs.
   * The key is the lexicographically sorted concatenation: `uuid1|uuid2`.
   * Max length = 36 + 1 + 36 = 73 characters (matches the column constraint).
   *
   * @param userId1 First participant UUID
   * @param userId2 Second participant UUID
   * @returns Deterministic pair key string
   */
  buildDmPairKey(userId1: string, userId2: string): string {
    const sorted = [userId1.toLowerCase(), userId2.toLowerCase()].sort();
    return `${sorted[0]}|${sorted[1]}`;
  }

  /**
   * Validate that a user has access to a channel and return their membership record.
   * Throws NotFoundException if the user is not an active member.
   *
   * @param channelId Channel UUID
   * @param userId    User UUID
   * @returns Active ChannelMember record
   */
  async validateChannelAccess(
    channelId: string,
    userId: string,
  ): Promise<ChannelMember> {
    const member = await this.memberRepo.findOne({
      where: { channelId, userId, leftAt: IsNull() },
    });

    if (!member) {
      throw new NotFoundException(
        `User ${userId} is not an active member of channel ${channelId}`,
      );
    }

    return member;
  }

  /**
   * Get the channel-level role for a user within a specific channel.
   * Returns undefined if the user is not an active member.
   *
   * @param channelId Channel UUID
   * @param userId    User UUID
   * @returns ChannelMemberRole or undefined
   */
  async getChannelMemberRole(
    channelId: string,
    userId: string,
  ): Promise<ChannelMemberRole | undefined> {
    const member = await this.memberRepo.findOne({
      where: { channelId, userId, leftAt: IsNull() },
      select: ['role'],
    });

    return member?.role;
  }

  /**
   * Check whether a user is currently an active member of a channel.
   *
   * @param channelId Channel UUID
   * @param userId    User UUID
   * @returns true if active membership exists
   */
  async isUserActiveInChannel(
    channelId: string,
    userId: string,
  ): Promise<boolean> {
    const count = await this.memberRepo.count({
      where: { channelId, userId, leftAt: IsNull() },
    });

    return count > 0;
  }

  /**
   * Persist a channel entity (used by resolver for simple updates like archive).
   *
   * @param channel Channel entity to save
   * @returns Saved Channel
   */
  async saveChannel(channel: Channel): Promise<Channel> {
    return this.channelRepo.save(channel);
  }

  /**
   * Persist a channel member entity (used by resolver for preference updates).
   *
   * @param member ChannelMember entity to save
   * @returns Saved ChannelMember
   */
  async saveMember(member: ChannelMember): Promise<ChannelMember> {
    return this.memberRepo.save(member);
  }
}
