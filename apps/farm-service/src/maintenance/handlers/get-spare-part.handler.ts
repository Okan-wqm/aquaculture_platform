/**
 * Get Spare Part (by id) Query Handler — fail-closed tenant boundary.
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import { SparePart } from '../entities/spare-part.entity';
import { GetSparePartQuery } from '../queries/get-spare-part.query';

@QueryHandler(GetSparePartQuery)
export class GetSparePartHandler implements IQueryHandler<GetSparePartQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GetSparePartQuery): Promise<SparePart> {
    const { tenantId, id } = query;
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const sparePart = await queryRunner.manager.findOne(SparePart, { where: { id, tenantId } });
      if (!sparePart) {
        throw new NotFoundException(`Yedek parça bulunamadı: ${id}`);
      }
      return sparePart;
    });
  }
}
