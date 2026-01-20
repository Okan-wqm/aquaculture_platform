import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Optional,
  Inject,
} from '@nestjs/common';
import { ICommandHandler, CommandHandler } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CreatePondBatchCommand } from '../commands/create-batch.command';
import { PondBatch, BatchStatus } from '../entities/batch.entity';
import { Pond, PondStatus } from '../entities/pond.entity';
import { NatsEventBus } from '@platform/event-bus';

/**
 * Create Pond Batch Command Handler
 * Handles the creation of a new batch in a pond (Farm module version)
 * Note: Renamed from CreateBatchHandler to avoid conflict with Batch module
 */
@Injectable()
@CommandHandler(CreatePondBatchCommand)
export class CreatePondBatchHandler
  implements ICommandHandler<CreatePondBatchCommand, PondBatch>
{
  private readonly logger = new Logger(CreatePondBatchHandler.name);

  constructor(
    @InjectRepository(PondBatch)
    private readonly batchRepository: Repository<PondBatch>,
    @InjectRepository(Pond)
    private readonly pondRepository: Repository<Pond>,
    @Optional() @Inject('EVENT_BUS')
    private readonly eventBus?: NatsEventBus,
  ) {}

  async execute(command: CreatePondBatchCommand): Promise<PondBatch> {
    this.logger.log(
      `Creating batch "${command.name}" in pond ${command.pondId}`,
    );

    // Verify pond exists
    const pond = await this.pondRepository.findOne({
      where: { id: command.pondId },
      relations: ['farm'],
    });

    if (!pond) {
      throw new NotFoundException(`Pond with ID ${command.pondId} not found`);
    }

    // Verify tenant access
    if (pond.tenantId !== command.tenantId) {
      throw new ForbiddenException('Access denied to this pond');
    }

    // Check pond status
    if (pond.status === PondStatus.INACTIVE) {
      throw new BadRequestException('Cannot create batch in an inactive pond');
    }

    if (pond.status === PondStatus.MAINTENANCE) {
      throw new BadRequestException(
        'Cannot create batch in a pond under maintenance',
      );
    }

    // Check for active batches in pond (optional - depends on business rules)
    const activeBatches = await this.batchRepository.count({
      where: {
        pondId: command.pondId,
        status: BatchStatus.ACTIVE,
      },
    });

    if (activeBatches > 0) {
      this.logger.warn(
        `Pond ${command.pondId} already has ${activeBatches} active batches`,
      );
      // Could throw an error here depending on business rules
    }

    // Create the batch entity
    const batch = this.batchRepository.create({
      name: command.name,
      species: command.species,
      quantity: command.quantity,
      currentQuantity: command.quantity,
      pondId: command.pondId,
      tenantId: command.tenantId,
      stockedAt: command.stockedAt,
      strain: command.strain,
      averageWeight: command.averageWeight,
      expectedHarvestDate: command.expectedHarvestDate,
      notes: command.notes,
      status: BatchStatus.ACTIVE,
      createdBy: command.userId,
    });

    // Save to database
    const savedBatch = await this.batchRepository.save(batch);

    // Publish domain event (optional - eventBus may not be available)
    await this.eventBus?.publish({
      eventId: crypto.randomUUID(),
      eventType: 'BatchCreated',
      timestamp: new Date(),
      payload: {
        batchId: savedBatch.id,
        pondId: savedBatch.pondId,
        farmId: pond.farmId,
        tenantId: savedBatch.tenantId,
        species: savedBatch.species,
        quantity: savedBatch.quantity,
        stockedAt: savedBatch.stockedAt,
      },
      metadata: {
        tenantId: savedBatch.tenantId,
        userId: command.userId,
        source: 'farm-service',
      },
    });

    this.logger.log(
      `Batch "${savedBatch.name}" created with ID ${savedBatch.id}`,
    );

    return savedBatch;
  }
}
