/**
 * Get Spare Part (by part number) Query Handler — fail-closed tenant boundary.
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import { SparePart } from '../entities/spare-part.entity';
import { GetSparePartByPartNumberQuery } from '../queries/get-spare-part-by-part-number.query';

@QueryHandler(GetSparePartByPartNumberQuery)
export class GetSparePartByPartNumberHandler
  implements IQueryHandler<GetSparePartByPartNumberQuery>
{
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GetSparePartByPartNumberQuery): Promise<SparePart> {
    const { tenantId, partNumber } = query;
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const sparePart = await queryRunner.manager.findOne(SparePart, {
        where: { partNumber, tenantId },
      });
      if (!sparePart) {
        throw new NotFoundException(`Yedek parça bulunamadı: ${partNumber}`);
      }
      return sparePart;
    });
  }
}
