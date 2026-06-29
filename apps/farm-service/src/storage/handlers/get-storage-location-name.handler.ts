/**
 * Get Storage-Location Name Query Handler — fail-closed tenant boundary
 * (FARM-HIGH-060). Returns the location name, or null when the location is
 * absent (the consuming GraphQL field is nullable).
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import { StorageLocation } from '../entities/storage-location.entity';
import { GetStorageLocationNameQuery } from '../queries/get-storage-location-name.query';

@QueryHandler(GetStorageLocationNameQuery)
export class GetStorageLocationNameHandler
  implements IQueryHandler<GetStorageLocationNameQuery, string | null>
{
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GetStorageLocationNameQuery): Promise<string | null> {
    const { tenantId, locationId } = query;
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const location = await queryRunner.manager.findOne(StorageLocation, {
        where: { id: locationId, tenantId },
        select: { id: true, name: true },
      });
      return location?.name ?? null;
    });
  }
}
