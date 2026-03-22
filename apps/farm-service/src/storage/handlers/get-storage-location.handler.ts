import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { GetStorageLocationQuery } from '../queries/get-storage-location.query';
import { StorageLocation } from '../entities/storage-location.entity';

@QueryHandler(GetStorageLocationQuery)
export class GetStorageLocationHandler implements IQueryHandler<GetStorageLocationQuery> {
  constructor(
    @InjectRepository(StorageLocation)
    private readonly locationRepository: Repository<StorageLocation>,
  ) {}

  async execute(query: GetStorageLocationQuery): Promise<StorageLocation> {
    const { locationId, tenantId } = query;

    const location = await this.locationRepository.findOne({
      where: { id: locationId, tenantId },
    });

    if (!location) {
      throw new NotFoundException(`Storage location with ID "${locationId}" not found`);
    }

    return location;
  }
}
