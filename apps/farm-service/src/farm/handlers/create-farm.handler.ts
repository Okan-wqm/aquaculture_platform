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
      isActive: true,
    });

    // Save to database
    const savedFarm = await this.farmRepository.save(farm);

    // Publish domain event
    await this.eventBus?.publish({
      eventId: crypto.randomUUID(),
      eventType: 'FarmCreated',
      timestamp: new Date(),
      payload: {
        farmId: savedFarm.id,
        tenantId: savedFarm.tenantId,
        name: savedFarm.name,
        location: savedFarm.location,
      },
      metadata: {
        tenantId: savedFarm.tenantId,
        userId: command.userId,
        source: 'farm-service',
      },
    });

    this.logger.log(`Farm "${savedFarm.name}" created with ID ${savedFarm.id}`);

    return savedFarm;
  }
}
