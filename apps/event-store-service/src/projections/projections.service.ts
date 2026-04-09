import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SchedulerRegistry } from '@nestjs/schedule';
import {
  ProjectionCheckpoint,
  ProjectionStatus,
} from './entities/projection-checkpoint.entity';
import { StoredEvent } from '../event-store/entities/stored-event.entity';
import { EventHandler, RetryPolicy } from '../event-store/interfaces/event-store.interfaces';

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
  private readonly registeredProjections = new Map<string, ProjectionRegistration>();
  private readonly processingLocks = new Map<string, boolean>();

  constructor(
    @InjectRepository(ProjectionCheckpoint)
    private readonly checkpointRepository: Repository<ProjectionCheckpoint>,
    @InjectRepository(StoredEvent)
    private readonly eventRepository: Repository<StoredEvent>,
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

    this.registeredProjections.set(name, registration);

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
    const registration = this.registeredProjections.get(name);
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

    // Start processing loop
    this.startProcessingLoop(name);

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
    this.clearProjectionInterval(name);

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
    const registration = this.registeredProjections.get(name);
    if (registration) {
      registration.cachedCheckpoint = undefined;
      registration.idleBatchCount = 0;
    }

    this.logger.log(`Reset projection ${name} to position ${position}`);
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
  async processBatch(name: string, tenantId: string): Promise<{
    processed: number;
    failed: number;
    newPosition: number;
  }> {
    // Key lock on name:tenantId for proper tenant isolation
    const lockKey = `${name}:${tenantId}`;

    // Check if already processing
    if (this.processingLocks.get(lockKey)) {
      return { processed: 0, failed: 0, newPosition: 0 };
    }

    this.processingLocks.set(lockKey, true);

    try {
      const registration = this.registeredProjections.get(name);
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
          await this.processEventWithRetry(
            registration.handler,
            {
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
            },
            registration.retryPolicy,
          );

          processed++;
          lastPosition = event.globalPosition;
          processingTimes.push(Date.now() - startTime);
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
            await this.checkpointRepository.save(checkpoint);
            // Stop the interval when transitioning to FAULTED
            this.clearProjectionInterval(name);
            break;
          }
        }
      }

      // Update checkpoint — only persist to DB when position actually advanced.
      // The in-memory cachedCheckpoint is mutated in place so the next batch
      // reads the correct position without a DB round-trip.
      const positionAdvanced = lastPosition !== checkpoint.position;

      checkpoint.position = lastPosition;
      checkpoint.eventsProcessed = checkpoint.eventsProcessed + processed;
      checkpoint.eventsFailed = checkpoint.eventsFailed + failed;
      checkpoint.lastProcessedAt = new Date();

      // Use exponential moving average (EMA) for processing time
      if (processingTimes.length > 0) {
        const avgTime =
          processingTimes.reduce((a, b) => a + b, 0) / processingTimes.length;
        checkpoint.avgProcessingTimeMs =
          EMA_ALPHA * avgTime + (1 - EMA_ALPHA) * checkpoint.avgProcessingTimeMs;
      }

      // Persist durably only when position advances; stats (eventsProcessed etc.)
      // are best-effort counters that catch up on the next persist.
      if (positionAdvanced) {
        await this.checkpointRepository.save(checkpoint);
        // Keep cachedCheckpoint pointing at the same mutated entity (already up to date)
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
   * Start the processing loop for a projection with adaptive back-off
   */
  private startProcessingLoop(name: string): void {
    const intervalName = `projection-${name}`;

    this.clearProjectionInterval(name);

    let currentDelay = 100;
    const minDelay = 100;
    const maxDelay = 5000;
    const backoffMultiplier = 2;

    const scheduleNext = () => {
      const jitter = 1 + (Math.random() * 0.4 - 0.2); // +/- 20%
      const actualDelay = Math.round(currentDelay * jitter);

      const timeout = setTimeout(async () => {
        try {
          const result = await this.processBatch(name, this.getProjectionTenantId(name));

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
   * Get the tenantId for a registered projection
   */
  private getProjectionTenantId(name: string): string {
    const registration = this.registeredProjections.get(name);
    return registration?.tenantId ?? '';
  }

  /**
   * Clear the processing interval for a projection
   */
  private clearProjectionInterval(name: string): void {
    const intervalName = `projection-${name}`;
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
