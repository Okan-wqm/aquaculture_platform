/**
 * Get Spare Part (by code) Query Handler — fail-closed tenant boundary.
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import { SparePart } from '../entities/spare-part.entity';
import { GetSparePartByCodeQuery } from '../queries/get-spare-part-by-code.query';

@QueryHandler(GetSparePartByCodeQuery)
export class GetSparePartByCodeHandler implements IQueryHandler<GetSparePartByCodeQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GetSparePartByCodeQuery): Promise<SparePart> {
    const { tenantId, code } = query;
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const sparePart = await queryRunner.manager.findOne(SparePart, { where: { code, tenantId } });
      if (!sparePart) {
        throw new NotFoundException(`Yedek parça bulunamadı: ${code}`);
      }
      return sparePart;
    });
  }
}
