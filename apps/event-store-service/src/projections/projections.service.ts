import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { SchedulerRegistry } from '@nestjs/schedule';
import {
  ProjectionCheckpoint,
  ProjectionStatus,
} from './entities/projection-checkpoint.entity';
import { StoredEvent } from '../event-store/entities/stored-event.entity';
import { EventHandler, RetryPolicy } from '../event-store/interfaces/event-store.interfaces';

interface ProjectionRegistration {
  name: string;
  handler: EventHandler;
  eventTypes?: string[];
  aggregateTypes?: string[];
  tenantId?: string;
  batchSize: number;
  retryPolicy: RetryPolicy;
}

@Injectable()
export class ProjectionsService {
  private readonly logger = new Logger(ProjectionsService.name);
  private readonly registeredProjections = new Map<string, ProjectionRegistration>();
  private readonly processingLocks = new Map<string, boolean>();

  constructor(
    @InjectRepository(ProjectionCheckpoint)
    private readonly checkpointRepository: Repository<ProjectionCheckpoint>,
    @InjectRepository(StoredEvent)
    private readonly eventRepository: Repository<StoredEvent>,
    @InjectDataSource()
    _dataSource: DataSource,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {}

  /**
   * Register a new projection
   */
  async registerProjection(
    name: string,
    handler: EventHandler,
    options: {
      description?: string;
      eventTypes?: string[];
      aggregateTypes?: string[];
      tenantId?: string;
      batchSize?: number;
      retryPolicy?: Partial<RetryPolicy>;
      startFromPosition?: number;
    } = {},
  ): Promise<ProjectionCheckpoint> {
    const registration: ProjectionRegistration = {
      name,
      handler,
      eventTypes: options.eventTypes,
      aggregateTypes: options.aggregateTypes,
      tenantId: options.tenantId,
      batchSize: options.batchSize || 100,
      retryPolicy: {
        maxRetries: options.retryPolicy?.maxRetries ?? 3,
        initialDelayMs: options.retryPolicy?.initialDelayMs ?? 1000,
        maxDelayMs: options.retryPolicy?.maxDelayMs ?? 30000,
        backoffMultiplier: options.retryPolicy?.backoffMultiplier ?? 2,
      },
    };

    this.registeredProjections.set(name, registration);

    // Create or update checkpoint
    let checkpoint = await this.checkpointRepository.findOne({
      where: { projectionName: name },
    });

    if (!checkpoint) {
      checkpoint = this.checkpointRepository.create({
        projectionName: name,
        description: options.description,
        position: options.startFromPosition || 0,
        status: ProjectionStatus.RUNNING,
        tenantId: options.tenantId,
        eventTypes: options.eventTypes || [],
        aggregateTypes: options.aggregateTypes || [],
      });
      await this.checkpointRepository.save(checkpoint);
    }

    this.logger.log(`Registered projection: ${name}`);
    return checkpoint;
  }

  /**
   * Start processing a projection
   */
  async startProjection(name: string): Promise<void> {
    const registration = this.registeredProjections.get(name);
    if (!registration) {
      throw new NotFoundException(`Projection ${name} not found`);
    }

    const checkpoint = await this.checkpointRepository.findOne({
      where: { projectionName: name },
    });

    if (!checkpoint) {
      throw new NotFoundException(`Checkpoint for projection ${name} not found`);
    }

    checkpoint.status = ProjectionStatus.RUNNING;
    await this.checkpointRepository.save(checkpoint);

    // Start processing loop
    this.startProcessingLoop(name);

    this.logger.log(`Started projection: ${name}`);
  }

  /**
   * Stop a projection
   */
  async stopProjection(name: string): Promise<void> {
    const checkpoint = await this.checkpointRepository.findOne({
      where: { projectionName: name },
    });

    if (!checkpoint) {
      throw new NotFoundException(`Checkpoint for projection ${name} not found`);
    }

    checkpoint.status = ProjectionStatus.STOPPED;
    await this.checkpointRepository.save(checkpoint);

    // Stop processing loop
    try {
      const intervalName = `projection-${name}`;
      if (this.schedulerRegistry.doesExist('interval', intervalName)) {
        this.schedulerRegistry.deleteInterval(intervalName);
      }
    } catch {
      // Interval may not exist
    }

    this.logger.log(`Stopped projection: ${name}`);
  }

  /**
   * Pause a projection
   */
  async pauseProjection(name: string): Promise<void> {
    const checkpoint = await this.checkpointRepository.findOne({
      where: { projectionName: name },
    });

    if (!checkpoint) {
      throw new NotFoundException(`Checkpoint for projection ${name} not found`);
    }

    checkpoint.status = ProjectionStatus.PAUSED;
    await this.checkpointRepository.save(checkpoint);

    this.logger.log(`Paused projection: ${name}`);
  }

  /**
   * Resume a paused projection
   */
  async resumeProjection(name: string): Promise<void> {
    const checkpoint = await this.checkpointRepository.findOne({
      where: { projectionName: name },
    });

    if (!checkpoint) {
      throw new NotFoundException(`Checkpoint for projection ${name} not found`);
    }

    if (checkpoint.status !== ProjectionStatus.PAUSED) {
      throw new Error(`Projection ${name} is not paused`);
    }

    checkpoint.status = ProjectionStatus.RUNNING;
    await this.checkpointRepository.save(checkpoint);

    this.logger.log(`Resumed projection: ${name}`);
  }

  /**
   * Reset a projection to a specific position
   */
  async resetProjection(name: string, position: number = 0): Promise<void> {
    const checkpoint = await this.checkpointRepository.findOne({
      where: { projectionName: name },
    });

    if (!checkpoint) {
      throw new NotFoundException(`Checkpoint for projection ${name} not found`);
    }

    checkpoint.position = position;
    checkpoint.eventsProcessed = 0;
    checkpoint.eventsFailed = 0;
    checkpoint.lastError = undefined;
    checkpoint.lastErrorAt = undefined;
    await this.checkpointRepository.save(checkpoint);

    this.logger.log(`Reset projection ${name} to position ${position}`);
  }

  /**
   * Get projection status
   */
  async getProjectionStatus(name: string): Promise<ProjectionCheckpoint | null> {
    return this.checkpointRepository.findOne({
      where: { projectionName: name },
    });
  }

  /**
   * Get all projections
   */
  async getAllProjections(): Promise<ProjectionCheckpoint[]> {
    return this.checkpointRepository.find({
      order: { projectionName: 'ASC' },
    });
  }

  /**
   * Get projection lag (events behind)
   */
  async getProjectionLag(name: string): Promise<number> {
    const checkpoint = await this.checkpointRepository.findOne({
      where: { projectionName: name },
    });

    if (!checkpoint) {
      throw new NotFoundException(`Checkpoint for projection ${name} not found`);
    }

    const latestEvent = await this.eventRepository
      .createQueryBuilder('e')
      .select('MAX(e.globalPosition)', 'maxPosition')
      .getRawOne();

    const maxPosition = parseInt(latestEvent?.maxPosition || '0', 10);
    return maxPosition - Number(checkpoint.position);
  }

  /**
   * Process a batch of events for a projection
   */
  async processBatch(name: string): Promise<{
    processed: number;
    failed: number;
    newPosition: number;
  }> {
    // Check if already processing
    if (this.processingLocks.get(name)) {
      return { processed: 0, failed: 0, newPosition: 0 };
    }

    this.processingLocks.set(name, true);

    try {
      const registration = this.registeredProjections.get(name);
      if (!registration) {
        throw new Error(`Projection ${name} not registered`);
      }

      const checkpoint = await this.checkpointRepository.findOne({
        where: { projectionName: name },
      });

      if (!checkpoint || checkpoint.status !== ProjectionStatus.RUNNING) {
        return { processed: 0, failed: 0, newPosition: 0 };
      }

      // Build query for events
      const queryBuilder = this.eventRepository
        .createQueryBuilder('e')
        .where('e.globalPosition > :position', { position: checkpoint.position })
        .orderBy('e.globalPosition', 'ASC')
        .take(registration.batchSize);

      if (registration.tenantId) {
        queryBuilder.andWhere('e.tenantId = :tenantId', {
          tenantId: registration.tenantId,
        });
      }

      if (registration.eventTypes && registration.eventTypes.length > 0) {
        queryBuilder.andWhere('e.eventType IN (:...eventTypes)', {
          eventTypes: registration.eventTypes,
        });
      }

      if (registration.aggregateTypes && registration.aggregateTypes.length > 0) {
        queryBuilder.andWhere('e.aggregateType IN (:...aggregateTypes)', {
          aggregateTypes: registration.aggregateTypes,
        });
      }

      const events = await queryBuilder.getMany();

      if (events.length === 0) {
        return {
          processed: 0,
          failed: 0,
          newPosition: Number(checkpoint.position),
        };
      }

      let processed = 0;
      let failed = 0;
      let lastPosition = Number(checkpoint.position);
      const processingTimes: number[] = [];

      for (const event of events) {
        const startTime = Date.now();

        try {
          await this.processEventWithRetry(
            registration.handler,
            {
              id: event.id,
              streamName: event.streamName,
              globalPosition: Number(event.globalPosition),
              streamPosition: Number(event.streamPosition),
              aggregateType: event.aggregateType,
              aggregateId: event.aggregateId,
              version: event.version,
              eventType: event.eventType,
              payload: event.payload,
              metadata: event.metadata,
              tenantId: event.tenantId,
              correlationId: event.correlationId,
              causationId: event.causationId,
              userId: event.userId,
              occurredAt: event.occurredAt,
              storedAt: event.storedAt,
              schemaVersion: event.schemaVersion,
            },
            registration.retryPolicy,
          );

          processed++;
          lastPosition = Number(event.globalPosition);
          processingTimes.push(Date.now() - startTime);
        } catch (error) {
          failed++;
          this.logger.error(
            `Failed to process event ${event.id} in projection ${name}: ${(error as Error).message}`,
          );

          // Update checkpoint with error
          checkpoint.lastError = (error as Error).message;
          checkpoint.lastErrorAt = new Date();

          // If configured to stop on error, mark as faulted
          if (failed >= registration.retryPolicy.maxRetries) {
            checkpoint.status = ProjectionStatus.FAULTED;
            await this.checkpointRepository.save(checkpoint);
            break;
          }
        }
      }

      // Update checkpoint
      checkpoint.position = lastPosition;
      checkpoint.eventsProcessed = Number(checkpoint.eventsProcessed) + processed;
      checkpoint.eventsFailed = Number(checkpoint.eventsFailed) + failed;
      checkpoint.lastProcessedAt = new Date();

      if (processingTimes.length > 0) {
        const avgTime =
          processingTimes.reduce((a, b) => a + b, 0) / processingTimes.length;
        checkpoint.avgProcessingTimeMs =
          (checkpoint.avgProcessingTimeMs + avgTime) / 2;
      }

      await this.checkpointRepository.save(checkpoint);

      return {
        processed,
        failed,
        newPosition: lastPosition,
      };
    } finally {
      this.processingLocks.set(name, false);
    }
  }

  /**
   * Process an event with retry logic
   */
  private async processEventWithRetry(
    handler: EventHandler,
    event: Parameters<EventHandler>[0],
    retryPolicy: RetryPolicy,
  ): Promise<void> {
    let lastError: Error | undefined;
    let delay = retryPolicy.initialDelayMs;

    for (let attempt = 0; attempt <= retryPolicy.maxRetries; attempt++) {
      try {
        await handler(event);
        return;
      } catch (error) {
        lastError = error as Error;

        if (attempt < retryPolicy.maxRetries) {
          await this.sleep(delay);
          delay = Math.min(
            delay * retryPolicy.backoffMultiplier,
            retryPolicy.maxDelayMs,
          );
        }
      }
    }

    throw lastError;
  }

  /**
   * Start the processing loop for a projection
   */
  private startProcessingLoop(name: string): void {
    const intervalName = `projection-${name}`;

    // Remove existing interval if any
    try {
      if (this.schedulerRegistry.doesExist('interval', intervalName)) {
        this.schedulerRegistry.deleteInterval(intervalName);
      }
    } catch {
      // Interval may not exist
    }

    // Create new processing interval (every 100ms)
    const interval = setInterval(async () => {
      try {
        await this.processBatch(name);
      } catch (error) {
        this.logger.error(
          `Error in projection ${name} processing loop: ${(error as Error).message}`,
        );
      }
    }, 100);

    this.schedulerRegistry.addInterval(intervalName, interval);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
