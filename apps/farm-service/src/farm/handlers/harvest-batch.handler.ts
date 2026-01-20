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
import { HarvestBatchCommand } from '../commands/harvest-batch.command';
import { PondBatch, BatchStatus } from '../entities/batch.entity';
import { Pond } from '../entities/pond.entity';
import { NatsEventBus } from '@platform/event-bus';

/**
 * Harvest Batch Command Handler
 * Handles the harvesting of a batch
 */
@Injectable()
@CommandHandler(HarvestBatchCommand)
export class HarvestBatchHandler
  implements ICommandHandler<HarvestBatchCommand, PondBatch>
{
  private readonly logger = new Logger(HarvestBatchHandler.name);

  constructor(
    @InjectRepository(PondBatch)
    private readonly batchRepository: Repository<PondBatch>,
    @InjectRepository(Pond)
    private readonly pondRepository: Repository<Pond>,
    @Optional() @Inject('EVENT_BUS')
    private readonly eventBus?: NatsEventBus,
  ) {}

  async execute(command: HarvestBatchCommand): Promise<PondBatch> {
    this.logger.log(`Harvesting batch ${command.batchId}`);

    // Find the batch
    const batch = await this.batchRepository.findOne({
      where: { id: command.batchId },
      relations: ['pond'],
    });

    if (!batch) {
      throw new NotFoundException(`Batch with ID ${command.batchId} not found`);
    }

    // Verify tenant access
    if (batch.tenantId !== command.tenantId) {
      throw new ForbiddenException('Access denied to this batch');
    }

    // Check batch status
    if (batch.status !== BatchStatus.ACTIVE) {
      throw new BadRequestException(
        `Batch is not active. Current status: ${batch.status}`,
      );
    }

    // Validate harvest data
    if (command.harvestedQuantity <= 0) {
      throw new BadRequestException('Harvested quantity must be positive');
    }

    if (command.harvestedQuantity > (batch.currentQuantity || batch.quantity)) {
      throw new BadRequestException(
        'Harvested quantity cannot exceed current quantity',
      );
    }

    // Get farm ID from pond
    const pond = await this.pondRepository.findOne({
      where: { id: batch.pondId },
    });

    // Update batch
    batch.status = BatchStatus.HARVESTED;
    batch.harvestedQuantity = command.harvestedQuantity;
    batch.harvestedWeight = command.harvestedWeight;
    batch.harvestedAt = command.harvestedAt || new Date();
    batch.updatedBy = command.userId;

    if (command.notes) {
      batch.notes = batch.notes
        ? `${batch.notes}\n\nHarvest Notes: ${command.notes}`
        : `Harvest Notes: ${command.notes}`;
    }

    // Save changes
    const updatedBatch = await this.batchRepository.save(batch);

    // Publish domain event
    await this.eventBus?.publish({
      eventId: crypto.randomUUID(),
      eventType: 'BatchHarvested',
      timestamp: new Date(),
      payload: {
        batchId: updatedBatch.id,
        pondId: updatedBatch.pondId,
        farmId: pond?.farmId,
        tenantId: updatedBatch.tenantId,
        species: updatedBatch.species,
        harvestedQuantity: updatedBatch.harvestedQuantity,
        harvestedWeight: updatedBatch.harvestedWeight,
        harvestedAt: updatedBatch.harvestedAt,
        growingDays: Math.ceil(
          (updatedBatch.harvestedAt!.getTime() -
            new Date(updatedBatch.stockedAt).getTime()) /
            (1000 * 60 * 60 * 24),
        ),
      },
      metadata: {
        tenantId: updatedBatch.tenantId,
        userId: command.userId,
        source: 'farm-service',
      },
    });

    this.logger.log(`Batch ${updatedBatch.id} harvested successfully`);

    return updatedBatch;
  }
}
