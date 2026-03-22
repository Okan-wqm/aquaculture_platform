import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConflictException, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { CreateStorageLocationCommand } from '../commands/create-storage-location.command';
import { StorageLocation } from '../entities/storage-location.entity';
import { Site } from '../../site/entities/site.entity';

@CommandHandler(CreateStorageLocationCommand)
export class CreateStorageLocationHandler implements ICommandHandler<CreateStorageLocationCommand, StorageLocation> {
  private readonly logger = new Logger(CreateStorageLocationHandler.name);

  constructor(
    @InjectRepository(StorageLocation)
    private readonly locationRepository: Repository<StorageLocation>,
    @InjectRepository(Site)
    private readonly siteRepository: Repository<Site>,
  ) {}

  async execute(command: CreateStorageLocationCommand): Promise<StorageLocation> {
    const { input, tenantId, userId } = command;

    this.logger.log(`Creating storage location "${input.name}" for tenant ${tenantId}`);

    const normalizedCode = input.code.toUpperCase();

    // Validate site
    const site = await this.siteRepository.findOne({
      where: { id: input.siteId, tenantId },
    });
    if (!site) {
      throw new NotFoundException(`Site with ID "${input.siteId}" not found`);
    }
    if (site.isDeleted) {
      throw new BadRequestException(`Site with ID "${input.siteId}" is deleted`);
    }

    // Check for duplicate code
    const existing = await this.locationRepository.findOne({
      where: { tenantId, code: normalizedCode },
    });
    if (existing) {
      throw new ConflictException(`Storage location with code "${normalizedCode}" already exists`);
    }

    const location = this.locationRepository.create({
      tenantId,
      siteId: input.siteId,
      name: input.name,
      code: normalizedCode,
      type: input.type,
      description: input.description,
      capacity: input.capacity,
      capacityUnit: input.capacityUnit ?? 'm3',
      usedCapacity: 0,
      temperatureMin: input.temperatureMin,
      temperatureMax: input.temperatureMax,
      humidityMin: input.humidityMin,
      humidityMax: input.humidityMax,
      isActive: true,
      createdBy: userId,
      updatedBy: userId,
    });

    const saved = await this.locationRepository.save(location);
    this.logger.log(`Storage location "${saved.name}" created with ID ${saved.id}`);
    return saved;
  }
}
