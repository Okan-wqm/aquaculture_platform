import {
  Injectable,
  Logger,
  ConflictException,
  Optional,
  Inject,
} from '@nestjs/common';
import { ICommandHandler, CommandHandler } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CreateFarmCommand } from '../commands/create-farm.command';
import { Farm } from '../entities/farm.entity';
import { NatsEventBus } from '@platform/event-bus';
import { createBaseEvent } from '@platform/event-contracts';

/**
 * Create Farm Command Handler
 * Handles the creation of a new farm
 */
@Injectable()
@CommandHandler(CreateFarmCommand)
export class CreateFarmHandler
  implements ICommandHandler<CreateFarmCommand, Farm>
{
  private readonly logger = new Logger(CreateFarmHandler.name);

  constructor(
    @InjectRepository(Farm)
    private readonly farmRepository: Repository<Farm>,
    @Optional() @Inject('EVENT_BUS')
    private readonly eventBus?: NatsEventBus,
  ) {}

  async execute(command: CreateFarmCommand): Promise<Farm> {
    this.logger.log(
      `Creating farm "${command.name}" for tenant ${command.tenantId}`,
    );

    // Check for duplicate farm name within tenant
    const existingFarm = await this.farmRepository.findOne({
      where: {
        name: command.name,
        tenantId: command.tenantId,
      },
    });

    if (existingFarm) {
      throw new ConflictException(
        `Farm with name "${command.name}" already exists`,
      );
    }

    // Create the farm entity
    const farm = this.farmRepository.create({
      name: command.name,
      location: command.location,
      tenantId: command.tenantId,
      address: command.address,
      contactPerson: command.contactPerson,
      contactPhone: command.contactPhone,
      contactEmail: command.contactEmail,
      description: command.description,
      totalArea: command.totalArea,
      createdBy: command.userId,
      updatedBy: command.userId,
      isActive: true,
    });

    // Save to database
    const savedFarm = await this.farmRepository.save(farm);

    // Publish domain event
    await this.eventBus?.publish({
      ...createBaseEvent('FarmCreated', savedFarm.tenantId, { aggregateId: savedFarm.id, aggregateType: 'Farm', userId: command.userId }),
      farmId: savedFarm.id,
      name: savedFarm.name,
      location: savedFarm.location,
    });

    this.logger.log(`Farm "${savedFarm.name}" created with ID ${savedFarm.id}`);

    return savedFarm;
  }
}
