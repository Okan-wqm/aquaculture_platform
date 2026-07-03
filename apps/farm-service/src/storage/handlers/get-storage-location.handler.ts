import { runInTenantRead } from '@aquaculture/backend-common/database';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { GetStorageLocationQuery } from '../queries/get-storage-location.query';
import { StorageLocation } from '../entities/storage-location.entity';

@QueryHandler(GetStorageLocationQuery)
export class GetStorageLocationHandler implements IQueryHandler<GetStorageLocationQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GetStorageLocationQuery): Promise<StorageLocation> {
    const { locationId, tenantId } = query;

    // Read through the fail-closed tenant boundary.
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const location = await queryRunner.manager.findOne(StorageLocation, {
        where: { id: locationId, tenantId },
      });

      if (!location) {
        throw new NotFoundException(`Storage location with ID "${locationId}" not found`);
      }

      return location;
    });
  }
}
