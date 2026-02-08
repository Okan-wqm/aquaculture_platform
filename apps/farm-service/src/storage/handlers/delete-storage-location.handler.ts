import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotFoundException, Logger, BadRequestException } from '@nestjs/common';
import { DeleteStorageLocationCommand } from '../commands/delete-storage-location.command';
import { StorageLocation } from '../entities/storage-location.entity';
import { StorageInventory } from '../entities/storage-inventory.entity';

@CommandHandler(DeleteStorageLocationCommand)
export class DeleteStorageLocationHandler implements ICommandHandler<DeleteStorageLocationCommand> {
  private readonly logger = new Logger(DeleteStorageLocationHandler.name);

  constructor(
    @InjectRepository(StorageLocation)
    private readonly locationRepository: Repository<StorageLocation>,
    @InjectRepository(StorageInventory)
    private readonly inventoryRepository: Repository<StorageInventory>,
  ) {}

  async execute(command: DeleteStorageLocationCommand): Promise<boolean> {
    const { locationId, tenantId, userId } = command;

    this.logger.log(`Deleting storage location ${locationId} for tenant ${tenantId}`);

    const location = await this.locationRepository.findOne({
      where: { id: locationId, tenantId },
    });

    if (!location) {
      throw new NotFoundException(`Storage location with ID "${locationId}" not found`);
    }

    // Check if location has inventory
    const inventoryCount = await this.inventoryRepository.count({
      where: { storageLocationId: locationId, tenantId },
    });

    if (inventoryCount > 0) {
      throw new BadRequestException(
        `Cannot delete storage location "${location.name}" because it contains ${inventoryCount} inventory items. Transfer or remove items first.`
      );
    }

    location.isDeleted = true;
    location.deletedAt = new Date();
    location.deletedBy = userId;
    location.isActive = false;
    location.updatedBy = userId;
    await this.locationRepository.save(location);

    this.logger.log(`Storage location ${locationId} marked as deleted`);
    return true;
  }
}
