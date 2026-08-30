/**
 * FeedingProtocolV2 sorgu handler'ları — fail-closed tenant okuma sınırı
 * (`runInTenantRead`) üzerinden, sayfalı.
 *
 * @module FeedingProtocol/QueryHandlers
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  QueryHandler,
  IQueryHandler,
  PaginatedQueryResult,
  createPaginatedQueryResult,
} from '@platform/cqrs';
import { runInTenantRead } from '@aquaculture/backend-common/database';

import {
  GetFeedingProtocolV2Query,
  ListFeedingProtocolsV2Query,
  ListProtocolAssignmentsQuery,
} from '../queries/feeding-protocol-v2.queries';
import { FeedingProtocolV2 } from '../entities/feeding-protocol-v2.entity';
import { ProtocolAssignment } from '../entities/protocol-assignment.entity';

@Injectable()
@QueryHandler(ListFeedingProtocolsV2Query)
export class ListFeedingProtocolsV2Handler
  implements IQueryHandler<ListFeedingProtocolsV2Query, PaginatedQueryResult<FeedingProtocolV2>>
{
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async execute(
    query: ListFeedingProtocolsV2Query,
  ): Promise<PaginatedQueryResult<FeedingProtocolV2>> {
    const { tenantId, filter, page, limit } = query;
    const [rows, total] = await runInTenantRead(
      this.dataSource,
      'farm',
      tenantId,
      async (queryRunner) => {
        const qb = queryRunner.manager
          .createQueryBuilder(FeedingProtocolV2, 'protocol')
          .where('protocol.tenantId = :tenantId', { tenantId })
          .andWhere('protocol.isDeleted = false');
        if (filter.status) {
          qb.andWhere('protocol.status = :status', { status: filter.status });
        }
        if (filter.speciesId) {
          qb.andWhere('protocol.speciesId = :speciesId', { speciesId: filter.speciesId });
        }
        qb.orderBy('protocol.name', 'ASC');
        const count = await qb.getCount();
        qb.skip((page - 1) * limit).take(limit);
        return [await qb.getMany(), count] as [FeedingProtocolV2[], number];
      },
    );
    return createPaginatedQueryResult(rows, page, limit, total);
  }
}

@Injectable()
@QueryHandler(GetFeedingProtocolV2Query)
export class GetFeedingProtocolV2Handler
  implements IQueryHandler<GetFeedingProtocolV2Query, FeedingProtocolV2>
{
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async execute(query: GetFeedingProtocolV2Query): Promise<FeedingProtocolV2> {
    const { protocolId, tenantId } = query;
    const protocol = await runInTenantRead(this.dataSource, 'farm', tenantId, (queryRunner) =>
      queryRunner.manager.findOne(FeedingProtocolV2, {
        where: { id: protocolId, tenantId, isDeleted: false },
      }),
    );
    if (!protocol) {
      throw new NotFoundException(`Protokol bulunamadı: ${protocolId}`);
    }
    return protocol;
  }
}

@Injectable()
@QueryHandler(ListProtocolAssignmentsQuery)
export class ListProtocolAssignmentsHandler
  implements IQueryHandler<ListProtocolAssignmentsQuery, PaginatedQueryResult<ProtocolAssignment>>
{
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async execute(
    query: ListProtocolAssignmentsQuery,
  ): Promise<PaginatedQueryResult<ProtocolAssignment>> {
    const { tenantId, filter, page, limit } = query;
    const [rows, total] = await runInTenantRead(
      this.dataSource,
      'farm',
      tenantId,
      async (queryRunner) => {
        const qb = queryRunner.manager
          .createQueryBuilder(ProtocolAssignment, 'assignment')
          .where('assignment.tenantId = :tenantId', { tenantId });
        if (filter.siteId) qb.andWhere('assignment.siteId = :siteId', { siteId: filter.siteId });
        if (filter.unitId) qb.andWhere('assignment.unitId = :unitId', { unitId: filter.unitId });
        if (filter.protocolId) {
          qb.andWhere('assignment.protocolId = :protocolId', { protocolId: filter.protocolId });
        }
        if (filter.status) qb.andWhere('assignment.status = :status', { status: filter.status });
        qb.orderBy('assignment.unitCode', 'ASC').addOrderBy('assignment.effectiveFrom', 'DESC');
        const count = await qb.getCount();
        qb.skip((page - 1) * limit).take(limit);
        return [await qb.getMany(), count] as [ProtocolAssignment[], number];
      },
    );
    return createPaginatedQueryResult(rows, page, limit, total);
  }
}
