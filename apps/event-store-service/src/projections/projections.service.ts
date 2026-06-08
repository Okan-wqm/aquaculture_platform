import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, In } from 'typeorm';
import { SchedulerRegistry } from '@nestjs/schedule';
import {
  ProjectionCheckpoint,
  ProjectionStatus,
} from './entities/projection-checkpoint.entity';
import {
  ACTIVE_PROJECTION_REBUILD_STATUSES,
  ProjectionRebuild,
  ProjectionRebuildStatus,
} from './entities/projection-rebuild.entity';
import { StoredEvent } from '../event-store/entities/stored-event.entity';
import {
  EventHandler,
  ProjectionHandlerContext,
  RetryPolicy,
} from '../event-store/interfaces/event-store.interfaces';

const MAX_ERROR_LENGTH = 500;
const EMA_ALPHA = 0.1;
const DECIMAL_POSITION_REGEX = /^\d+$/;

/**
 * Number of idle batches (no events returned) between full checkpoint DB re-reads.
 * During idle periods the status check polls the DB every N skipped batches to
 * detect external pauses/stops without issuing a query on every 100 ms tick.
 */
const IDLE_STATUS_RECHECK_BATCHES = 10;

function toDecimalPosition(value: string | number | bigint | undefined): string {
  if (value === undefined) {
    return '0';
  }
  const position = value.toString();
  if (!DECIMAL_POSITION_REGEX.test(position)) {
    throw new Error(`Projection position must be a decimal string, got: ${position}`);
  }
  return position;
}

function subtractDecimalPositions(maxPosition: string, checkpointPosition: string): string {
  const lag = BigInt(toDecimalPosition(maxPosition)) - BigInt(toDecimalPosition(checkpointPosition));
  if (lag < 0n) {
    throw new Error(
      `Projection checkpoint position ${checkpointPosition} is ahead of filtered event log ${maxPosition}`,
    );
  }
  return lag.toString();
}

interface ProjectionRegistration {
  name: string;
  handler: EventHandler;
  eventTypes?: string[];
  aggregateTypes?: string[];
  tenantId: string;
  batchSize: number;
  retryPolicy: RetryPolicy;
  /**
   * Cached checkpoint entity.  Avoids a DB read on every processBatch call.
   * Populated on first batch; invalidated on reset/stop/pause.
   */
  cachedCheckpoint?: ProjectionCheckpoint;
  /** Counts consecutive idle batches since the last DB status re-read. */
  idleBatchCount: number;
}

@Injectable()
export class ProjectionsService {
  private readonly logger = new Logger(ProjectionsService.name);
  // SECURITY: Projections are keyed by (tenantId, name) to prevent tenant collision.
  // Previously keyed only by name, the last tenant to register would overwrite
  // prior registrations with the same projection name.
  private readonly registeredProjections = new Map<string, ProjectionRegistration>();
  private readonly processingLocks = new Map<string, boolean>();

  /** Generate a tenant-safe projection key */
  private getProjectionKey(tenantId: string, name: string): string {
    return `${tenantId}:${name}`;
  }

  constructor(
    @InjectRepository(ProjectionCheckpoint)
    private readonly checkpointRepository: Repository<ProjectionCheckpoint>,
    @InjectRepository(ProjectionRebuild)
    private readonly rebuildRepository: Repository<ProjectionRebuild>,
    @InjectRepository(StoredEvent)
    private readonly eventRepository: Repository<StoredEvent>,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly dataSource: DataSource,
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
      tenantId: string;
      batchSize?: number;
      retryPolicy?: Partial<RetryPolicy>;
      startFromPosition?: string | number;
    },
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
      idleBatchCount: 0,
    };

    // SECURITY: Key by (tenantId, name) to prevent tenant collision.
    const projKey = this.getProjectionKey(options.tenantId, name);
    this.registeredProjections.set(projKey, registration);

    // Create or update checkpoint
    let checkpoint = await this.checkpointRepository.findOne({
      where: { projectionName: name, tenantId: options.tenantId },
    });

    if (!checkpoint) {
      checkpoint = this.checkpointRepository.create({
        projectionName: name,
        description: options.description,
        position: toDecimalPosition(options.startFromPosition),
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
  async startProjection(name: string, tenantId: string): Promise<void> {
    const registration = this.registeredProjections.get(this.getProjectionKey(tenantId, name));
    if (!registration) {
      throw new NotFoundException(`Projection ${name} not found`);
    }

    const checkpoint = await this.checkpointRepository.findOne({
      where: { projectionName: name, tenantId },
    });

    if (!checkpoint) {
      throw new NotFoundException(`Checkpoint for projection ${name} not found`);
    }

    checkpoint.status = ProjectionStatus.RUNNING;
    await this.checkpointRepository.save(checkpoint);
    registration.cachedCheckpoint = checkpoint;
    registration.idleBatchCount = 0;

    // Start processing loop
    this.startProcessingLoop(name, tenantId);

    this.logger.log(`Started projection: ${name}`);
  }

  /**
   * Stop a projection
   */
  async stopProjection(name: string, tenantId: string): Promise<void> {
    const checkpoint = await this.checkpointRepository.findOne({
      where: { projectionName: name, tenantId },
    });

    if (!checkpoint) {
      throw new NotFoundException(`Checkpoint for projection ${name} not found`);
    }

    checkpoint.status = ProjectionStatus.STOPPED;
    await this.checkpointRepository.save(checkpoint);

    // Stop processing loop
    this.clearProjectionInterval(name, tenantId);

    this.logger.log(`Stopped projection: ${name}`);
  }

  /**
   * Pause a projection
   */
  async pauseProjection(name: string, tenantId: string): Promise<void> {
    const checkpoint = await this.checkpointRepository.findOne({
      where: { projectionName: name, tenantId },
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
  async resumeProjection(name: string, tenantId: string): Promise<void> {
    const checkpoint = await this.checkpointRepository.findOne({
      where: { projectionName: name, tenantId },
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
  async requestProjectionRebuild(
    name: string,
    tenantId: string,
    request: {
      requestedFromPosition: string;
      reason: string;
      requestedBy?: string;
      correlationId?: string;
      idempotencyKey?: string;
    },
  ): Promise<{
    jobId: string;
    projectionName: string;
    tenantId: string;
    requestedFromPosition: string;
    sourceGeneration: number;
    targetGeneration: number;
    status: ProjectionRebuildStatus;
  }> {
    if (!DECIMAL_POSITION_REGEX.test(request.requestedFromPosition)) {
      throw new Error('requestedFromPosition must be a decimal string');
    }
    const checkpoint = await this.checkpointRepository.findOne({
      where: { projectionName: name, tenantId },
    });

    if (!checkpoint) {
      throw new NotFoundException(`Checkpoint for projection ${name} not found`);
    }

    const registration = this.registeredProjections.get(this.getProjectionKey(tenantId, name));
    if (registration) {
      registration.cachedCheckpoint = undefined;
      registration.idleBatchCount = 0;
    }

    const targetGeneration = checkpoint.generation + 1;
    if (request.idempotencyKey) {
      const existing = await this.rebuildRepository.findOne({
        where: {
          tenantId,
          projectionName: name,
          idempotencyKey: request.idempotencyKey,
        },
      });
      if (existing) {
        return {
          jobId: existing.jobId,
          projectionName: existing.projectionName,
          tenantId: existing.tenantId,
          requestedFromPosition: existing.requestedFromPosition,
          sourceGeneration: existing.sourceGeneration,
          targetGeneration: existing.targetGeneration,
          status: existing.status,
        };
      }
    }

    const activeJob = await this.rebuildRepository.findOne({
      where: {
        tenantId,
        projectionName: name,
        status: In([...ACTIVE_PROJECTION_REBUILD_STATUSES]),
      },
    });
    if (activeJob) {
      throw new ConflictException(
        `Projection ${tenantId}:${name} already has active rebuild job ${activeJob.jobId}`,
      );
    }

    const rebuild = await this.rebuildRepository.save(
      this.rebuildRepository.create({
        jobId: randomUUID(),
        tenantId,
        projectionName: name,
        requestedFromPosition: request.requestedFromPosition,
        sourceGeneration: checkpoint.generation,
        targetGeneration,
        status: ProjectionRebuildStatus.REQUESTED,
        requestedBy: request.requestedBy ?? null,
        reason: request.reason,
        correlationId: request.correlationId ?? null,
        idempotencyKey: request.idempotencyKey ?? null,
      }),
    );
    this.logger.warn(
      `Projection rebuild requested for ${tenantId}:${name} from position ${request.requestedFromPosition} targeting generation ${targetGeneration}`,
      {
        jobId: rebuild.jobId,
        reason: request.reason,
        requestedBy: request.requestedBy,
        correlationId: request.correlationId,
        idempotencyKey: request.idempotencyKey,
      },
    );

    return {
      jobId: rebuild.jobId,
      projectionName: name,
      tenantId,
      requestedFromPosition: request.requestedFromPosition,
      sourceGeneration: checkpoint.generation,
      targetGeneration,
      status: rebuild.status,
    };
  }

  /**
   * Get projection status
   */
  async getProjectionStatus(name: string, tenantId: string): Promise<ProjectionCheckpoint | null> {
    return this.checkpointRepository.findOne({
      where: { projectionName: name, tenantId },
    });
  }

  /**
   * Get all projections for a tenant
   */
  async getAllProjections(tenantId: string): Promise<ProjectionCheckpoint[]> {
    return this.checkpointRepository.find({
      where: { tenantId },
      order: { projectionName: 'ASC' },
    });
  }

  /**
   * Get projection lag (events behind) scoped to the tenant
   */
  async getProjectionLag(name: string, tenantId: string): Promise<string> {
    const checkpoint = await this.checkpointRepository.findOne({
      where: { projectionName: name, tenantId },
    });

    if (!checkpoint) {
      throw new NotFoundException(`Checkpoint for projection ${name} not found`);
    }

    const queryBuilder = this.eventRepository
      .createQueryBuilder('e')
      .select('MAX(e.globalPosition)', 'maxPosition')
      .where('e.tenantId = :tenantId', { tenantId });

    if (checkpoint.eventTypes.length > 0) {
      queryBuilder.andWhere('e.eventType IN (:...eventTypes)', {
        eventTypes: checkpoint.eventTypes,
      });
    }

    if (checkpoint.aggregateTypes.length > 0) {
      queryBuilder.andWhere('e.aggregateType IN (:...aggregateTypes)', {
        aggregateTypes: checkpoint.aggregateTypes,
      });
    }

    const latestEvent = await queryBuilder.getRawOne();

    try {
      return subtractDecimalPositions(String(latestEvent?.maxPosition || '0'), checkpoint.position);
    } catch (error) {
      throw new Error(
        `Projection ${name} ${(error as Error).message}`,
      );
    }
  }

  /**
   * Process a batch of events for a projection
   */
  async processBatch(name: string, tenantId: string): Promise<{
    processed: number;
    failed: number;
    newPosition: string;
  }> {
    // Key lock on name:tenantId for proper tenant isolation
    const lockKey = `${name}:${tenantId}`;

    // Check if already processing
    if (this.processingLocks.get(lockKey)) {
      return { processed: 0, failed: 0, newPosition: '0' };
    }

    this.processingLocks.set(lockKey, true);

    try {
      const registration = this.registeredProjections.get(this.getProjectionKey(tenantId, name));
      if (!registration) {
        throw new Error(`Projection ${name} not registered`);
      }

      // Load checkpoint from DB only on first call (cache cold) or periodically
      // during idle runs to detect external stop/pause/reset commands.
      // When events are being processed the checkpoint is re-read on every batch
      // to reflect any position changes that may have been applied externally.
      const needsDbRead =
        registration.cachedCheckpoint === undefined ||
        registration.idleBatchCount >= IDLE_STATUS_RECHECK_BATCHES;

      let checkpoint: ProjectionCheckpoint | null;

      if (needsDbRead) {
        checkpoint = await this.checkpointRepository.findOne({
          where: { projectionName: name, tenantId },
        });

        if (!checkpoint || checkpoint.status !== ProjectionStatus.RUNNING) {
          // Evict stale cache so the next batch re-reads once the projection restarts
          registration.cachedCheckpoint = undefined;
          registration.idleBatchCount = 0;
          return { processed: 0, failed: 0, newPosition: '0' };
        }

        // Refresh the cache
        registration.cachedCheckpoint = checkpoint;
        registration.idleBatchCount = 0;
      } else {
        // Use the cached entity — avoid a DB round-trip entirely
        checkpoint = registration.cachedCheckpoint!;
      }

      // Build query for events starting after the cached checkpoint position
      const queryBuilder = this.eventRepository
        .createQueryBuilder('e')
        .where('e.globalPosition > :position', { position: checkpoint.position })
        .andWhere('e.tenantId = :tenantId', { tenantId: registration.tenantId })
        .orderBy('e.globalPosition', 'ASC')
        .take(registration.batchSize);

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
        // Track idle batches for periodic status re-read throttling
        registration.idleBatchCount++;
        return {
          processed: 0,
          failed: 0,
          newPosition: checkpoint.position,
        };
      }

      // Events found — reset idle counter so we stay in fast-path
      registration.idleBatchCount = 0;

      let processed = 0;
      let failed = 0;
      let lastPosition = checkpoint.position;
      let currentPosition = checkpoint.position;
      let currentEventsProcessed = checkpoint.eventsProcessed;
      const processingTimes: number[] = [];

      for (const event of events) {
        const startTime = Date.now();

        try {
          // SECURITY (PLAT-CRITICAL-004): Wrap handler callback + checkpoint
          // update in a single database transaction. If the handler succeeds
          // but checkpoint persistence fails, both are rolled back. This
          // prevents duplicate side effects on restart after a crash between
          // the handler apply and checkpoint save.
          const queryRunner = this.dataSource.createQueryRunner();
          await queryRunner.connect();
          await queryRunner.startTransaction();

          try {
            await this.processEventWithRetry(
              registration.handler,
              {
                id: event.id,
                streamName: event.streamName,
                globalPosition: event.globalPosition,
                streamPosition: event.streamPosition,
                producer: event.producer,
                producerEventId: event.producerEventId,
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
              {
                manager: queryRunner.manager,
                tenantId,
                projectionName: name,
                sourceGeneration: checkpoint.generation,
                targetGeneration: checkpoint.generation,
                leaseToken: null,
                mode: 'live',
                outboxPolicy: 'transactional',
              },
              registration.retryPolicy,
            );

            // Update checkpoint position atomically within the same transaction
            const expectedPosition = currentPosition;
            const expectedGeneration = checkpoint.generation;
            const updateResult = await queryRunner.manager.update(
              ProjectionCheckpoint,
              {
                id: checkpoint.id,
                tenantId,
                projectionName: name,
                position: expectedPosition,
                generation: expectedGeneration,
                status: ProjectionStatus.RUNNING,
              },
              {
                position: event.globalPosition,
                eventsProcessed: currentEventsProcessed + 1,
                lastProcessedAt: new Date(),
              },
            );
            if (updateResult.affected !== 1) {
              throw new Error(
                `Projection ${tenantId}:${name} checkpoint CAS failed at position ${expectedPosition}`,
              );
            }

            await queryRunner.commitTransaction();

            processed++;
            lastPosition = event.globalPosition;
            currentPosition = event.globalPosition;
            currentEventsProcessed++;
            processingTimes.push(Date.now() - startTime);
          } catch (txError) {
            await queryRunner.rollbackTransaction();
            throw txError;
          } finally {
            await queryRunner.release();
          }
        } catch (error) {
          failed++;
          this.logger.error(
            `Failed to process event ${event.id} in projection ${name}: ${(error as Error).message}`,
          );

          // Truncate error message before storing
          const errorMsg = (error as Error).message || 'Unknown error';
          checkpoint.lastError = errorMsg.length > MAX_ERROR_LENGTH
            ? errorMsg.substring(0, MAX_ERROR_LENGTH)
            : errorMsg;
          checkpoint.lastErrorAt = new Date();

          // Any event that exhausts retries faults the projection
          if (failed >= 1) {
            checkpoint.status = ProjectionStatus.FAULTED;
            await this.checkpointRepository.update(
              {
                id: checkpoint.id,
                tenantId,
                projectionName: name,
                position: currentPosition,
                generation: checkpoint.generation,
              },
              {
                status: ProjectionStatus.FAULTED,
                lastError: checkpoint.lastError,
                lastErrorAt: checkpoint.lastErrorAt,
                eventsFailed: checkpoint.eventsFailed + failed,
              },
            );
            // Stop the interval when transitioning to FAULTED
            this.clearProjectionInterval(name, tenantId);
            break;
          }
        }
      }

      // Update in-memory cached checkpoint to reflect the persisted state.
      // The per-event transaction already persisted position; update the
      // in-memory entity so the next batch reads the correct position
      // without a DB round-trip.
      checkpoint.position = lastPosition;
      checkpoint.eventsProcessed = currentEventsProcessed;
      checkpoint.eventsFailed = checkpoint.eventsFailed + failed;
      checkpoint.lastProcessedAt = new Date();

      // Use exponential moving average (EMA) for processing time
      if (processingTimes.length > 0) {
        const avgTime =
          processingTimes.reduce((a, b) => a + b, 0) / processingTimes.length;
        checkpoint.avgProcessingTimeMs =
          EMA_ALPHA * avgTime + (1 - EMA_ALPHA) * checkpoint.avgProcessingTimeMs;
      }

      // Persist remaining stats (eventsFailed, avgProcessingTimeMs) that were
      // not covered by the per-event transaction. These are best-effort counters.
      if (failed > 0 || processingTimes.length > 0) {
        await this.checkpointRepository.update(
          {
            id: checkpoint.id,
            tenantId,
            projectionName: name,
            position: lastPosition,
            generation: checkpoint.generation,
          },
          {
            eventsFailed: checkpoint.eventsFailed,
            avgProcessingTimeMs: checkpoint.avgProcessingTimeMs,
            lastProcessedAt: checkpoint.lastProcessedAt,
          },
        );
      }

      return {
        processed,
        failed,
        newPosition: lastPosition,
      };
    } finally {
      const lockKey = `${name}:${tenantId}`;
      this.processingLocks.set(lockKey, false);
    }
  }

  /**
   * Process an event with retry logic
   */
  private async processEventWithRetry(
    handler: EventHandler,
    event: Parameters<EventHandler>[0],
    context: ProjectionHandlerContext,
    retryPolicy: RetryPolicy,
  ): Promise<void> {
    let lastError: Error | undefined;
    let delay = retryPolicy.initialDelayMs;

    for (let attempt = 0; attempt <= retryPolicy.maxRetries; attempt++) {
      const savepoint = `projection_handler_attempt_${attempt}`;
      try {
        await context.manager.query(`SAVEPOINT ${savepoint}`);
        await context.manager.query(
          `SELECT set_config('app.current_tenant', $1, true) /* projection handler RLS */`,
          [context.tenantId],
        );
        await handler(event, context);
        await context.manager.query(`RELEASE SAVEPOINT ${savepoint}`);
        return;
      } catch (error) {
        lastError = error as Error;
        try {
          await context.manager.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          await context.manager.query(`RELEASE SAVEPOINT ${savepoint}`);
        } catch (rollbackError) {
          this.logger.warn(
            `Failed to roll back projection handler savepoint ${savepoint}: ${
              (rollbackError as Error).message
            }`,
          );
          throw lastError;
        }

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
   * Start the processing loop for a projection with adaptive back-off
   */
  private startProcessingLoop(name: string, tenantId: string): void {
    const intervalName = `projection-${tenantId}-${name}`;

    this.clearProjectionInterval(name, tenantId);

    let currentDelay = 100;
    const minDelay = 100;
    const maxDelay = 5000;
    const backoffMultiplier = 2;

    const scheduleNext = () => {
      const jitter = 1 + (Math.random() * 0.4 - 0.2); // +/- 20%
      const actualDelay = Math.round(currentDelay * jitter);

      const timeout = setTimeout(async () => {
        try {
          const result = await this.processBatch(name, tenantId);

          // Adaptive back-off: if no events processed, increase delay
          if (result.processed === 0) {
            currentDelay = Math.min(currentDelay * backoffMultiplier, maxDelay);
          } else {
            currentDelay = minDelay;
          }
        } catch (error) {
          this.logger.error(
            `Error in projection ${name} processing loop: ${(error as Error).message}`,
          );
        }

        // Schedule next iteration if interval still registered
        try {
          if (this.schedulerRegistry.doesExist('interval', intervalName)) {
            scheduleNext();
          }
        } catch {
          // Interval was removed, stop scheduling
        }
      }, actualDelay);

      // Store as interval for compatibility with scheduler registry
      try {
        if (this.schedulerRegistry.doesExist('interval', intervalName)) {
          this.schedulerRegistry.deleteInterval(intervalName);
        }
      } catch {
        // OK
      }
      this.schedulerRegistry.addInterval(intervalName, timeout as NodeJS.Timeout);
    };

    scheduleNext();
  }

  /**
   * Clear the processing interval for a projection
   */
  private clearProjectionInterval(name: string, tenantId: string): void {
    const intervalName = `projection-${tenantId}-${name}`;
    try {
      if (this.schedulerRegistry.doesExist('interval', intervalName)) {
        this.schedulerRegistry.deleteInterval(intervalName);
      }
    } catch {
      // Interval may not exist
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
