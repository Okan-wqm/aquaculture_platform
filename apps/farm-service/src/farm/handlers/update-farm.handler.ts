import {
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  Inject,
} from '@nestjs/common';
import { ICommandHandler, CommandHandler } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UpdateFarmCommand } from '../commands/update-farm.command';
import { Farm } from '../entities/farm.entity';
import { NatsEventBus } from '@platform/event-bus';
import { createBaseEvent } from '@platform/event-contracts';

/**
 * Update Farm Command Handler
 * Handles updating an existing farm
 */
@Injectable()
@CommandHandler(UpdateFarmCommand)
export class UpdateFarmHandler
  implements ICommandHandler<UpdateFarmCommand, Farm>
{
  private readonly logger = new Logger(UpdateFarmHandler.name);

  constructor(
    @InjectRepository(Farm)
    private readonly farmRepository: Repository<Farm>,
    @Optional() @Inject('EVENT_BUS')
    private readonly eventBus?: NatsEventBus,
  ) {}

  async execute(command: UpdateFarmCommand): Promise<Farm> {
    this.logger.log(
      `Updating farm ${command.farmId} for tenant ${command.tenantId}`,
    );

    const farm = await this.farmRepository.findOne({
      where: { id: command.farmId, tenantId: command.tenantId },
    });

    if (!farm) {
      throw new NotFoundException(`Farm with ID ${command.farmId} not found`);
    }

    // Update fields if provided
    if (command.name !== undefined) farm.name = command.name;
    if (command.location !== undefined) farm.location = command.location;
    if (command.address !== undefined) farm.address = command.address;
    if (command.contactPerson !== undefined) farm.contactPerson = command.contactPerson;
    if (command.contactPhone !== undefined) farm.contactPhone = command.contactPhone;
    if (command.contactEmail !== undefined) farm.contactEmail = command.contactEmail;
    if (command.description !== undefined) farm.description = command.description;
    if (command.totalArea !== undefined) farm.totalArea = command.totalArea;
    if (command.isActive !== undefined) farm.isActive = command.isActive;

    // Track who updated the farm
    farm.updatedBy = command.userId;

    // Save to database
    const savedFarm = await this.farmRepository.save(farm);

    // Publish domain event
    await this.eventBus?.publish({
      ...createBaseEvent('FarmUpdated', savedFarm.tenantId, { aggregateId: savedFarm.id, aggregateType: 'Farm', userId: command.userId }),
      farmId: savedFarm.id,
      name: savedFarm.name,
      location: savedFarm.location,
    });

    this.logger.log(`Farm "${savedFarm.name}" updated with ID ${savedFarm.id}`);

    return savedFarm;
  }
}
