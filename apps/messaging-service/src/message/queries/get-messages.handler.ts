import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { Logger, ForbiddenException, BadRequestException } from '@nestjs/common';
import { DataSource, IsNull } from 'typeorm';

import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { GetMessagesQuery } from './get-messages.query';
import { Message } from '../entities/message.entity';
import { ChannelMember } from '../../channel/entities/channel-member.entity';

/**
 * Decoded cursor containing the keyset fields for pagination.
 */
interface DecodedCursor {
  createdAt: string;
  id: string;
}

/**
 * Paginated result for messages.
 */
export interface MessagePage {
  items: Message[];
  hasMore: boolean;
  cursor: string | null;
}

/**
 * Encode a cursor from the last message in the page.
 */
function encodeCursor(message: Message): string {
  const payload: DecodedCursor = {
    createdAt: message.createdAt.toISOString(),
    id: message.id,
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

/**
 * Decode an opaque cursor string to keyset fields.
 */
function decodeCursor(cursor: string): DecodedCursor {
  const json = Buffer.from(cursor, 'base64url').toString('utf-8');
  return JSON.parse(json) as DecodedCursor;
}

/**
 * Handler for GetMessagesQuery.
 *
 * SECURITY (C-06): Tenant isolation is enforced at two levels:
 *   1. PostgreSQL search_path — set by TenantSchemaMiddleware per-request to
 *      the tenant-specific schema (tenant_<uuid>), so all TypeORM queries
 *      automatically target the correct tenant's tables.
 *   2. Defense-in-depth — this handler validates that tenantId is present in
 *      the query object and includes it in audit logs. The tenantId comes from
 *      the controller which extracts it from the verified JWT, not from any
 *      user-controlled input.
 *
 * - Validates user is a channel member (within tenant schema)
 * - Uses keyset pagination on (createdAt DESC, id DESC)
 * - Eager loads attachments via LEFT JOIN
 * - Filters out soft-deleted messages
 */
@QueryHandler(GetMessagesQuery)
export class GetMessagesHandler implements IQueryHandler<GetMessagesQuery, MessagePage> {
  private readonly logger = new Logger(GetMessagesHandler.name);

  constructor(
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GetMessagesQuery): Promise<MessagePage> {
    const { tenantId, userId, channelId, limit, cursor, before, after } = query;

    // SECURITY (C-06): Require tenantId as defense-in-depth. The primary tenant
    // isolation is the PostgreSQL search_path (set by TenantSchemaMiddleware),
    // but we assert tenantId presence to catch programming errors where a query
    // is dispatched without proper tenant context.
    if (!tenantId) {
      throw new BadRequestException(
        'Tenant context is required for message queries.',
      );
    }

    return runInTenantTransaction(this.dataSource, 'messaging', tenantId, async (queryRunner) => {
      // Tenant-pinned query path matches the send/edit/delete command path.
      const membership = await queryRunner.manager.findOne(ChannelMember, {
        where: { tenantId, channelId, userId, leftAt: IsNull() },
      });
      if (!membership) {
        throw new ForbiddenException('You are not a member of this channel.');
      }

      const qb = queryRunner.manager
        .createQueryBuilder(Message, 'm')
        .leftJoinAndSelect('m.attachments', 'att')
        .where('m."tenantId" = :tenantId', { tenantId })
        .andWhere('m."channelId" = :channelId', { channelId })
        .andWhere('m."isDeleted" = false');

      // Apply cursor (keyset)
      if (cursor) {
        const decoded = decodeCursor(cursor);
        qb.andWhere(
          '(m."createdAt" < :cursorDate OR (m."createdAt" = :cursorDate AND m."id" < :cursorId))',
          {
            cursorDate: decoded.createdAt,
            cursorId: decoded.id,
          },
        );
      }

      // Apply date filters
      if (before) {
        qb.andWhere('m."createdAt" < :before', { before });
      }
      if (after) {
        qb.andWhere('m."createdAt" > :after', { after });
      }

      // Order by createdAt DESC, id DESC for stable keyset pagination
      qb.orderBy('m."createdAt"', 'DESC').addOrderBy('m."id"', 'DESC');

      // Fetch one extra row to determine hasMore
      qb.take(limit + 1);

      const messages = await qb.getMany();

      const hasMore = messages.length > limit;
      const items = hasMore ? messages.slice(0, limit) : messages;
      const nextCursor = items.length > 0 ? encodeCursor(items[items.length - 1]!) : null;

      this.logger.debug(
        `GetMessages: tenant=${tenantId}, channel=${channelId}, returned=${items.length}, hasMore=${hasMore}`,
      );

      return { items, hasMore, cursor: nextCursor };
    });
  }
}
