import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { Logger, ForbiddenException, BadRequestException } from '@nestjs/common';
import { Repository, IsNull } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';

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
    @InjectRepository(Message)
    private readonly messageRepo: Repository<Message>,
    @InjectRepository(ChannelMember)
    private readonly channelMemberRepo: Repository<ChannelMember>,
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

    // 1. Validate channel membership (within tenant schema via search_path)
    const membership = await this.channelMemberRepo.findOne({
      where: { channelId, userId, leftAt: IsNull() },
    });
    if (!membership) {
      throw new ForbiddenException('You are not a member of this channel.');
    }

    // 2. Fetch messages since timestamp (tenant-scoped via search_path)
    const messages = await this.messageRepo
      .createQueryBuilder('m')
      .leftJoinAndSelect('m.attachments', 'att')
      .where('m."channelId" = :channelId', { channelId })
      .andWhere('m."createdAt" > :since', { since })
      .andWhere('m."isDeleted" = false')
      .orderBy('m."createdAt"', 'ASC')
      .addOrderBy('m."id"', 'ASC')
      .take(SYNC_LIMIT)
      .getMany();

    this.logger.debug(
      `GetMessagesSince: tenant=${tenantId}, channel=${channelId}, since=${since.toISOString()}, returned=${messages.length}`,
    );

    return messages;
  }
}
