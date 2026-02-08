import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not } from 'typeorm';
import { ConflictException, NotFoundException, Logger } from '@nestjs/common';
import { UpdateStorageLocationCommand } from '../commands/update-storage-location.command';
import { StorageLocation } from '../entities/storage-location.entity';

@CommandHandler(UpdateStorageLocationCommand)
export class UpdateStorageLocationHandler implements ICommandHandler<UpdateStorageLocationCommand> {
  private readonly logger = new Logger(UpdateStorageLocationHandler.name);

  constructor(
    @InjectRepository(StorageLocation)
    private readonly locationRepository: Repository<StorageLocation>,
  ) {}

  async execute(command: UpdateStorageLocationCommand): Promise<StorageLocation> {
    const { locationId, input, tenantId, userId } = command;

    this.logger.log(`Updating storage location ${locationId} for tenant ${tenantId}`);

    const location = await this.locationRepository.findOne({
      where: { id: locationId, tenantId },
    });

    if (!location) {
      throw new NotFoundException(`Storage location with ID "${locationId}" not found`);
    }

    if (input.code) {
      const normalizedCode = input.code.toUpperCase();
      if (normalizedCode !== location.code) {
        const existing = await this.locationRepository.findOne({
          where: { tenantId, code: normalizedCode, id: Not(locationId) },
        });
        if (existing) {
          throw new ConflictException(`Storage location with code "${normalizedCode}" already exists`);
        }
      }
    }

    Object.assign(location, {
      ...input,
      code: input.code ? input.code.toUpperCase() : location.code,
      updatedBy: userId,
    });

    const updated = await this.locationRepository.save(location);
    this.logger.log(`Storage location ${locationId} updated successfully`);
    return updated;
  }
}
