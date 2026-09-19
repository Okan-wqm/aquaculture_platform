import { Injectable, Logger, NotFoundException, ForbiddenException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { runInTenantRead, runInTenantTransaction } from '@aquaculture/backend-common/database';
import { Message } from '../entities/message.entity';
import { ChannelMember } from '../../channel/entities/channel-member.entity';
import { unreadMessagePredicateSql } from '../unread-message.predicate';

/**
 * Core domain service for message operations.
 * Handles ownership validation, unread counts (DB-authoritative — MSG-HIGH-066),
 * and shared logic used across commands/queries.
 */
@Injectable()
export class MessageService {
  private readonly logger = new Logger(MessageService.name);

  constructor(private readonly dataSource: DataSource) {}

  /**
   * Validates that a user owns a specific message.
   * @throws NotFoundException if message does not exist
   * @returns the Message entity
   */
  async validateMessageOwnership(
    tenantId: string,
    messageId: string,
    userId: string,
  ): Promise<Message> {
    const message = await runInTenantTransaction(
      this.dataSource,
      'messaging',
      tenantId,
      async (queryRunner) =>
        queryRunner.manager.findOne(Message, {
          where: { tenantId, id: messageId, isDeleted: false },
        }),
    );
    if (!message) {
      throw new NotFoundException(`Message ${messageId} not found.`);
    }
    if (message.senderId !== userId) {
      throw new ForbiddenException('You can only modify your own messages.');
    }
    return message;
  }

  /**
   * Get the total unread message count for a user across all channels.
   *
   * MSG-HIGH-066: the unread count now has ONE authority — the database, via the
   * canonical `unreadMessagePredicateSql` SSoT that the per-channel channel-list
   * badge also uses, so the global badge and the per-channel badges can never
   * diverge. The previous Redis HASH was incremented on every send but NEVER
   * decremented on read (mark-read cleared a different, unread key), and its
   * non-empty state suppressed the DB fallback — so `totalUnreadMessageCount`
   * grew monotonically and permanently disagreed with the per-channel counts.
   * The HASH (and its increment/decrement machinery) is removed as the drifting
   * second source of truth.
   */
  async getUnreadCount(userId: string, tenantId: string): Promise<number> {
    return this.getUnreadCountFromDb(tenantId, userId);
  }

  /**
   * Batched badge lookup for the push fan-out (MSGFIX-FAZ3 3.4).
   *
   * The push service used to call `getUnreadCount` once PER RECIPIENT — a
   * global unread COUNT (messages ⨝ channel_members) per member per message,
   * executed serially. For a channel with N offline members that is N
   * identical-shape scans on the hottest send path. This method resolves the
   * SAME value (each user's GLOBAL unread total — notification-service
   * renders it as the app-icon badge, which is a global count by contract,
   * see NotificationSendPushCommand.templateVariables.badge) for a WHOLE
   * batch in ONE query: it is literally getUnreadCountFromDb's join-count
   * with the bound `:userId` swapped for the joined `cm."userId"` column and
   * an IN(...) batch filter (both through the same canonical predicate
   * helper, so it cannot drift from the single-user path or the channel-list
   * badge).
   *
   * The result is grouped per user; a user with zero unread is simply absent
   * from the map (callers default to 0).
   */
  async getUnreadCountsForUsers(tenantId: string, userIds: string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (userIds.length === 0) {
      return counts;
    }

    const rows = await runInTenantRead(
      this.dataSource,
      'messaging',
      tenantId,
      async (queryRunner) =>
        queryRunner.manager
          .createQueryBuilder(Message, 'm')
          .select('cm."userId"', 'userId')
          .addSelect('COUNT(*)::int', 'unread')
          .innerJoin(
            ChannelMember,
            'cm',
            'cm."tenantId" = :tenantId AND cm."userId" IN (:...userIds) AND cm."leftAt" IS NULL',
            { tenantId, userIds },
          )
          .where('m."tenantId" = :tenantId', { tenantId })
          .andWhere('m."channelId" = cm."channelId"')
          // Canonical unread predicate (ORPHAN-100) — column-ref form: the
          // "not my own message" test compares against the JOINED member row
          // so one query counts for the whole batch.
          .andWhere(
            unreadMessagePredicateSql({
              msg: 'm',
              lastReadAt: 'cm."lastReadAt"',
              userIdSql: 'cm."userId"',
            }),
          )
          .groupBy('cm."userId"')
          .getRawMany<{ userId: string; unread: number | string }>(),
    );

    for (const row of rows) {
      counts.set(
        row.userId,
        typeof row.unread === 'number' ? row.unread : parseInt(row.unread, 10),
      );
    }
    return counts;
  }

  /**
   * Fallback: calculate unread from database when Redis is unavailable.
   * Counts messages after lastReadAt across all channels the user is a member of.
   */
  private async getUnreadCountFromDb(tenantId: string, userId: string): Promise<number> {
    return runInTenantTransaction(this.dataSource, 'messaging', tenantId, async (queryRunner) =>
      queryRunner.manager
        .createQueryBuilder(Message, 'm')
        .innerJoin(
          ChannelMember,
          'cm',
          'cm."tenantId" = :tenantId AND cm."channelId" = m."channelId" AND cm."userId" = :userId',
          { tenantId, userId },
        )
        .where('m."tenantId" = :tenantId', { tenantId })
        .andWhere('cm."leftAt" IS NULL')
        // Canonical unread predicate (ORPHAN-100): isDeleted=false AND not own
        // AND newer-than-lastReadAt — shared byte-for-byte with the channel-list
        // badge subquery so the two counts cannot diverge.
        .andWhere(
          unreadMessagePredicateSql({
            msg: 'm',
            lastReadAt: 'cm."lastReadAt"',
            userIdParam: 'userId',
          }),
          { userId },
        )
        .getCount(),
    );
  }
}
