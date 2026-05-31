import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, MoreThan, Repository } from 'typeorm';
import { SchedulerRegistry } from '@nestjs/schedule';
import { ProjectionCheckpoint, ProjectionStatus } from './entities/projection-checkpoint.entity';
import { ProjectionInbox } from './entities/projection-inbox.entity';
import { StoredEvent } from '../event-store/entities/stored-event.entity';
import {
  EventHandler,
  PersistedEvent,
  RetryPolicy,
} from '../event-store/interfaces/event-store.interfaces';

const MAX_ERROR_LENGTH = 500;
const EMA_ALPHA = 0.1;

/**
 * Number of idle batches (no events returned) between full checkpoint DB re-reads.
 * During idle periods the status check polls the DB every N skipped batches to
 * detect external pauses/stops without issuing a query on every 100 ms tick.
 */
const IDLE_STATUS_RECHECK_BATCHES = 10;

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
    @InjectRepository(ProjectionInbox)
    private readonly inboxRepository: Repository<ProjectionInbox>,
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
      startFromPosition?: number;
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
  async startProjection(name: string, tenantId: string): Promise<void> {
    const projectionKey = this.getProjectionKey(tenantId, name);
    const registration = this.registeredProjections.get(projectionKey);
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

    this.logger.log(`Started projection: ${projectionKey}`);
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

    const projectionKey = this.getProjectionKey(tenantId, name);
    const registration = this.registeredProjections.get(projectionKey);
    if (registration) {
      registration.cachedCheckpoint = undefined;
      registration.idleBatchCount = 0;
    }

    // Stop processing loop
    this.clearProjectionInterval(name, tenantId);

    this.logger.log(`Stopped projection: ${projectionKey}`);
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

    const projectionKey = this.getProjectionKey(tenantId, name);
    const registration = this.registeredProjections.get(projectionKey);
    if (registration) {
      registration.cachedCheckpoint = undefined;
      registration.idleBatchCount = 0;
    }
    this.clearProjectionInterval(name, tenantId);

    this.logger.log(`Paused projection: ${projectionKey}`);
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

    const projectionKey = this.getProjectionKey(tenantId, name);
    const registration = this.registeredProjections.get(projectionKey);
    if (registration) {
      registration.cachedCheckpoint = checkpoint;
      registration.idleBatchCount = 0;
      this.startProcessingLoop(name, tenantId);
    }

    this.logger.log(`Resumed projection: ${projectionKey}`);
  }

  /**
   * Reset a projection to a specific position
   */
  async resetProjection(name: string, position: number = 0, tenantId: string): Promise<void> {
    const checkpoint = await this.checkpointRepository.findOne({
      where: { projectionName: name, tenantId },
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

    // Invalidate in-memory checkpoint cache so the next processBatch re-reads
    // from the DB and picks up the new position.
    const projectionKey = this.getProjectionKey(tenantId, name);
    const registration = this.registeredProjections.get(projectionKey);
    if (registration) {
      registration.cachedCheckpoint = undefined;
      registration.idleBatchCount = 0;
    }
    await this.inboxRepository.delete({
      tenantId,
      projectionName: name,
      globalPosition: MoreThan(position),
    });

    this.logger.log(`Reset projection ${projectionKey} to position ${position}`);
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
  async getProjectionLag(name: string, tenantId: string): Promise<number> {
    const checkpoint = await this.checkpointRepository.findOne({
      where: { projectionName: name, tenantId },
    });

    if (!checkpoint) {
      throw new NotFoundException(`Checkpoint for projection ${name} not found`);
    }

    // Filter by tenantId to avoid leaking cross-tenant event count
    const latestEvent = await this.eventRepository
      .createQueryBuilder('e')
      .select('MAX(e.globalPosition)', 'maxPosition')
      .where('e.tenantId = :tenantId', { tenantId })
      .getRawOne();

    const maxPosition = parseInt(latestEvent?.maxPosition || '0', 10);
    return maxPosition - checkpoint.position;
  }

  /**
   * Process a batch of events for a projection
   */
  async processBatch(
    name: string,
    tenantId: string,
  ): Promise<{
    processed: number;
    failed: number;
    newPosition: number;
  }> {
    const projectionKey = this.getProjectionKey(tenantId, name);

    // Check if already processing
    if (this.processingLocks.get(projectionKey)) {
      return { processed: 0, failed: 0, newPosition: 0 };
    }

    this.processingLocks.set(projectionKey, true);

    try {
      const registration = this.registeredProjections.get(projectionKey);
      if (!registration) {
        throw new Error(`Projection ${projectionKey} not registered`);
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
          return { processed: 0, failed: 0, newPosition: 0 };
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
      const processingTimes: number[] = [];

      for (const event of events) {
        const startTime = Date.now();

        try {
          const outcome = await this.processEventInTransactionWithRetry(
            name,
            tenantId,
            registration,
            checkpoint.id,
            event,
          );

          if (outcome.stopped) {
            registration.cachedCheckpoint = undefined;
            break;
          }

          if (outcome.applied) {
            processed++;
            processingTimes.push(Date.now() - startTime);
          }
          if (outcome.advanced) {
            lastPosition = outcome.position;
          }
        } catch (error) {
          failed++;
          this.logger.error(
            `Failed to process event ${event.id} in projection ${projectionKey}: ${(error as Error).message}`,
          );

          // Truncate error message before storing
          const errorMsg = (error as Error).message || 'Unknown error';
          checkpoint.lastError =
            errorMsg.length > MAX_ERROR_LENGTH ? errorMsg.substring(0, MAX_ERROR_LENGTH) : errorMsg;
          checkpoint.lastErrorAt = new Date();

          // Any event that exhausts retries faults the projection
          if (failed >= 1) {
            checkpoint.status = ProjectionStatus.FAULTED;
            await this.markProjectionFaulted(checkpoint.id, errorMsg);
            // Stop the interval when transitioning to FAULTED
            this.clearProjectionInterval(name, tenantId);
            registration.cachedCheckpoint = undefined;
            break;
          }
        }
      }

      // Update in-memory cached checkpoint to reflect the persisted state.
      // The per-event transaction already persisted position; update the
      // in-memory entity so the next batch reads the correct position
      // without a DB round-trip.
      checkpoint.position = lastPosition;
      checkpoint.eventsProcessed = checkpoint.eventsProcessed + processed;
      checkpoint.eventsFailed = checkpoint.eventsFailed + failed;
      checkpoint.lastProcessedAt = new Date();

      // Use exponential moving average (EMA) for processing time
      if (processingTimes.length > 0) {
        const avgTime = processingTimes.reduce((a, b) => a + b, 0) / processingTimes.length;
        checkpoint.avgProcessingTimeMs =
          EMA_ALPHA * avgTime + (1 - EMA_ALPHA) * checkpoint.avgProcessingTimeMs;
        await this.checkpointRepository.update(checkpoint.id, {
          avgProcessingTimeMs: checkpoint.avgProcessingTimeMs,
        });
      }

      return {
        processed,
        failed,
        newPosition: lastPosition,
      };
    } finally {
      this.processingLocks.set(projectionKey, false);
    }
  }

  private async processEventInTransaction(
    name: string,
    tenantId: string,
    registration: ProjectionRegistration,
    checkpointId: string,
    event: StoredEvent,
  ): Promise<{
    applied: boolean;
    advanced: boolean;
    position: number;
    stopped: boolean;
  }> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const lockedCheckpoint = await queryRunner.manager.findOne(ProjectionCheckpoint, {
        where: { id: checkpointId, tenantId, projectionName: name },
        lock: { mode: 'pessimistic_write' },
      });

      if (!lockedCheckpoint || lockedCheckpoint.status !== ProjectionStatus.RUNNING) {
        await queryRunner.commitTransaction();
        return {
          applied: false,
          advanced: false,
          position: lockedCheckpoint?.position ?? 0,
          stopped: true,
        };
      }

      if (lockedCheckpoint.position >= event.globalPosition) {
        await queryRunner.commitTransaction();
        return {
          applied: false,
          advanced: false,
          position: lockedCheckpoint.position,
          stopped: false,
        };
      }

      const insertedInboxRows: Array<{ id: string }> = await queryRunner.manager.query(
        `INSERT INTO "event_store"."projection_inbox"
           ("tenantId", "projectionName", "eventId", "globalPosition", "processedAt")
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT ("tenantId", "projectionName", "eventId") DO NOTHING
         RETURNING "id"`,
        [tenantId, name, event.id, event.globalPosition],
      );

      const applied = insertedInboxRows.length > 0;
      if (applied) {
        await registration.handler(this.toPersistedEvent(event), {
          manager: queryRunner.manager,
        });
      }

      await queryRunner.manager.query(
        `UPDATE "event_store"."projection_checkpoints"
            SET "position" = $1,
                "eventsProcessed" = "eventsProcessed" + $2,
                "lastProcessedAt" = NOW(),
                "updatedAt" = NOW()
          WHERE "id" = $3`,
        [event.globalPosition, applied ? 1 : 0, checkpointId],
      );

      await queryRunner.commitTransaction();
      return {
        applied,
        advanced: true,
        position: event.globalPosition,
        stopped: false,
      };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  private async processEventInTransactionWithRetry(
    name: string,
    tenantId: string,
    registration: ProjectionRegistration,
    checkpointId: string,
    event: StoredEvent,
  ): Promise<{
    applied: boolean;
    advanced: boolean;
    position: number;
    stopped: boolean;
  }> {
    let lastError: Error | undefined;
    let delay = registration.retryPolicy.initialDelayMs;

    for (let attempt = 0; attempt <= registration.retryPolicy.maxRetries; attempt++) {
      try {
        return await this.processEventInTransaction(
          name,
          tenantId,
          registration,
          checkpointId,
          event,
        );
      } catch (error) {
        lastError = error as Error;
        if (attempt < registration.retryPolicy.maxRetries) {
          await this.sleep(delay);
          delay = Math.min(
            delay * registration.retryPolicy.backoffMultiplier,
            registration.retryPolicy.maxDelayMs,
          );
        }
      }
    }

    throw lastError ?? new Error('Projection retry failed without an error');
  }

  private toPersistedEvent(event: StoredEvent): PersistedEvent {
    return {
      id: event.id,
      streamName: event.streamName,
      globalPosition: event.globalPosition,
      streamPosition: event.streamPosition,
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
    };
  }

  private async markProjectionFaulted(checkpointId: string, errorMessage: string): Promise<void> {
    const lastError =
      errorMessage.length > MAX_ERROR_LENGTH
        ? errorMessage.substring(0, MAX_ERROR_LENGTH)
        : errorMessage;

    await this.dataSource.query(
      `UPDATE "event_store"."projection_checkpoints"
          SET "status" = $1,
              "eventsFailed" = "eventsFailed" + 1,
              "lastError" = $2,
              "lastErrorAt" = NOW(),
              "updatedAt" = NOW()
        WHERE "id" = $3`,
      [ProjectionStatus.FAULTED, lastError, checkpointId],
    );
  }

  /**
   * Start the processing loop for a projection with adaptive back-off
   */
  private startProcessingLoop(name: string, tenantId: string): void {
    const intervalName = this.getProjectionIntervalName(tenantId, name);

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
            `Error in projection ${this.getProjectionKey(tenantId, name)} processing loop: ${(error as Error).message}`,
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

  private getProjectionIntervalName(tenantId: string, name: string): string {
    return `projection:${this.getProjectionKey(tenantId, name)}`;
  }

  /**
   * Clear the processing interval for a projection
   */
  private clearProjectionInterval(name: string, tenantId: string): void {
    const intervalName = this.getProjectionIntervalName(tenantId, name);
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
