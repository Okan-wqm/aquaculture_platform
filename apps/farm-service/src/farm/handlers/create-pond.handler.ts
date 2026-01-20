import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  Optional,
  Inject,
} from '@nestjs/common';
import { ICommandHandler, CommandHandler } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CreatePondCommand } from '../commands/create-pond.command';
import { Pond, WaterType, PondStatus } from '../entities/pond.entity';
import { Farm } from '../entities/farm.entity';
import { NatsEventBus } from '@platform/event-bus';

/**
 * Create Pond Command Handler
 * Handles the creation of a new pond within a farm
 */
@Injectable()
@CommandHandler(CreatePondCommand)
export class CreatePondHandler
  implements ICommandHandler<CreatePondCommand, Pond>
{
  private readonly logger = new Logger(CreatePondHandler.name);

  constructor(
    @InjectRepository(Pond)
    private readonly pondRepository: Repository<Pond>,
    @InjectRepository(Farm)
    private readonly farmRepository: Repository<Farm>,
    @Optional() @Inject('EVENT_BUS')
    private readonly eventBus?: NatsEventBus,
  ) {}

  async execute(command: CreatePondCommand): Promise<Pond> {
    this.logger.log(
      `Creating pond "${command.name}" in farm ${command.farmId}`,
    );

    // Verify farm exists and belongs to tenant
    const farm = await this.farmRepository.findOne({
      where: { id: command.farmId },
    });

    if (!farm) {
      throw new NotFoundException(`Farm with ID ${command.farmId} not found`);
    }

    if (farm.tenantId !== command.tenantId) {
      throw new ForbiddenException('Access denied to this farm');
    }

    // Check for duplicate pond name within farm
    const existingPond = await this.pondRepository.findOne({
      where: {
        name: command.name,
        farmId: command.farmId,
      },
    });

    if (existingPond) {
      throw new ConflictException(
        `Pond with name "${command.name}" already exists in this farm`,
      );
    }

    // Create the pond entity
    const pond = this.pondRepository.create({
      name: command.name,
      farmId: command.farmId,
      capacity: command.capacity,
      waterType: command.waterType || WaterType.FRESHWATER,
      depth: command.depth,
      surfaceArea: command.surfaceArea,
      status: command.status || PondStatus.ACTIVE,
      tenantId: command.tenantId,
      createdBy: command.userId,
      isActive: true,
    });

    // Save to database
    const savedPond = await this.pondRepository.save(pond);

    // Publish domain event
    await this.eventBus?.publish({
      eventId: crypto.randomUUID(),
      eventType: 'PondCreated',
      timestamp: new Date(),
      payload: {
        pondId: savedPond.id,
        farmId: savedPond.farmId,
        tenantId: savedPond.tenantId,
        name: savedPond.name,
        capacity: savedPond.capacity,
        waterType: savedPond.waterType,
      },
      metadata: {
        tenantId: savedPond.tenantId,
        userId: command.userId,
        source: 'farm-service',
      },
    });

    this.logger.log(`Pond "${savedPond.name}" created with ID ${savedPond.id}`);

    return savedPond;
  }
}
