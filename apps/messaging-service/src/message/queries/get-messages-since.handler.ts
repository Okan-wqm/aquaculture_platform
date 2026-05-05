import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { Logger, ForbiddenException, BadRequestException } from '@nestjs/common';
import { DataSource, IsNull } from 'typeorm';

import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { GetMessagesSinceQuery } from './get-messages-since.query';
import { Message } from '../entities/message.entity';
import { ChannelMember } from '../../channel/entities/channel-member.entity';

/** Hard limit for offline sync to prevent unbounded queries */
const SYNC_LIMIT = 500;

/**
 * Handler for GetMessagesSinceQuery.
 *
 * Returns messages created after a given timestamp in a specific channel.
 * Used for offline sync scenarios (mobile reconnection, etc.).
 *
 * SECURITY (C-06): Tenant isolation is enforced at two levels:
 *   1. PostgreSQL search_path — set by TenantSchemaMiddleware per-request to
 *      the tenant-specific schema (tenant_<uuid>), so all TypeORM queries
 *      automatically target the correct tenant's tables.
 *   2. Defense-in-depth — this handler validates that tenantId is present in
 *      the query object. The tenantId comes from the controller which extracts
 *      it from the verified JWT, not from any user-controlled input.
 */
@QueryHandler(GetMessagesSinceQuery)
export class GetMessagesSinceHandler
  implements IQueryHandler<GetMessagesSinceQuery, Message[]>
{
  private readonly logger = new Logger(GetMessagesSinceHandler.name);

  constructor(
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GetMessagesSinceQuery): Promise<Message[]> {
    const { tenantId, userId, channelId, since } = query;

    // SECURITY (C-06): Require tenantId as defense-in-depth. The primary tenant
    // isolation is the PostgreSQL search_path (set by TenantSchemaMiddleware),
    // but we assert tenantId presence to catch programming errors where a query
    // is dispatched without proper tenant context.
    if (!tenantId) {
      throw new BadRequestException(
        'Tenant context is required for message sync queries.',
      );
    }

    return runInTenantTransaction(this.dataSource, 'messaging', tenantId, async (queryRunner) => {
      const membership = await queryRunner.manager.findOne(ChannelMember, {
        where: { tenantId, channelId, userId, leftAt: IsNull() },
      });
      if (!membership) {
        throw new ForbiddenException('You are not a member of this channel.');
      }

      const messages = await queryRunner.manager
        .createQueryBuilder(Message, 'm')
        .leftJoinAndSelect('m.attachments', 'att')
        .where('m."tenantId" = :tenantId', { tenantId })
        .andWhere('m."channelId" = :channelId', { channelId })
        .andWhere('m."createdAt" > :since', { since })
        .andWhere('m."isDeleted" = false')
        .orderBy('m.createdAt', 'ASC')
        .addOrderBy('m.id', 'ASC')
        .take(SYNC_LIMIT)
        .getMany();

      this.logger.debug(
        `GetMessagesSince: tenant=${tenantId}, channel=${channelId}, since=${since.toISOString()}, returned=${messages.length}`,
      );

      return messages;
    });
  }
}
