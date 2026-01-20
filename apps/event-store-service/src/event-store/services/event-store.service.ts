import {
  Injectable,
  Logger,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource, MoreThan, FindOptionsWhere } from 'typeorm';
import { StoredEvent } from '../entities/stored-event.entity';
import { EventStream } from '../entities/event-stream.entity';
import { Snapshot } from '../entities/snapshot.entity';
import {
  DomainEvent,
  PersistedEvent,
  AppendResult,
  EventStreamSlice,
  AllEventsSlice,
  ReadOptions,
  ReadAllOptions,
  ConcurrencyCheckResult,
  SnapshotData,
} from '../interfaces/event-store.interfaces';

@Injectable()
export class EventStoreService {
  private readonly logger = new Logger(EventStoreService.name);

  constructor(
    @InjectRepository(StoredEvent)
    private readonly eventRepository: Repository<StoredEvent>,
    @InjectRepository(EventStream)
    private readonly streamRepository: Repository<EventStream>,
    @InjectRepository(Snapshot)
    private readonly snapshotRepository: Repository<Snapshot>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Append events to a stream with optimistic concurrency control
   */
  async appendToStream(
    tenantId: string,
    aggregateType: string,
    aggregateId: string,
    events: DomainEvent[],
    expectedVersion: number,
  ): Promise<AppendResult> {
    const streamName = this.buildStreamName(aggregateType, aggregateId);
    const queryRunner = this.dataSource.createQueryRunner();

    await queryRunner.connect();
    await queryRunner.startTransaction('SERIALIZABLE');

    try {
      // Get or create stream with lock
      let stream = await queryRunner.manager.findOne(EventStream, {
        where: { streamName, tenantId },
        lock: { mode: 'pessimistic_write' },
      });

      const currentVersion = stream?.currentVersion ?? 0;

      // Concurrency check
      if (expectedVersion !== -1 && expectedVersion !== currentVersion) {
        throw new ConflictException(
          `Concurrency conflict: expected version ${expectedVersion}, but current version is ${currentVersion}`,
        );
      }

      // Create stream if new
      if (!stream) {
        stream = queryRunner.manager.create(EventStream, {
          streamName,
          aggregateType,
          aggregateId,
          tenantId,
          currentVersion: 0,
          eventCount: 0,
        });
      }

      const eventIds: string[] = [];
      const globalPositions: number[] = [];
      let newVersion = currentVersion;

      // Get the current max global position
      const maxPositionResult = await queryRunner.manager
        .createQueryBuilder(StoredEvent, 'e')
        .select('MAX(e.globalPosition)', 'maxPosition')
        .getRawOne();

      let nextGlobalPosition = (parseInt(maxPositionResult?.maxPosition || '0', 10)) + 1;

      // Append each event
      for (const event of events) {
        newVersion++;
        const globalPosition = nextGlobalPosition++;

        const storedEvent = queryRunner.manager.create(StoredEvent, {
          streamName,
          globalPosition,
          streamPosition: newVersion,
          aggregateType,
          aggregateId,
          version: newVersion,
          eventType: event.eventType,
          payload: event.payload,
          metadata: event.metadata,
          tenantId,
          correlationId: event.correlationId,
          causationId: event.causationId,
          userId: event.userId,
          occurredAt: event.occurredAt || new Date(),
          schemaVersion: event.schemaVersion || 1,
        });

        const savedEvent = await queryRunner.manager.save(storedEvent);
        eventIds.push(savedEvent.id);
        globalPositions.push(globalPosition);
      }

      // Update stream metadata
      stream.currentVersion = newVersion;
      stream.eventCount = Number(stream.eventCount) + events.length;
      stream.lastEventAt = new Date();
      await queryRunner.manager.save(stream);

      await queryRunner.commitTransaction();

      this.logger.log(
        `Appended ${events.length} events to stream ${streamName}, new version: ${newVersion}`,
      );

      return {
        success: true,
        streamName,
        newVersion,
        eventIds,
        globalPositions,
      };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error(
        `Failed to append events to stream ${streamName}: ${(error as Error).message}`,
        (error as Error).stack,
      );
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Read events from a stream
   */
  async readStream(
    tenantId: string,
    aggregateType: string,
    aggregateId: string,
    options: ReadOptions = {},
  ): Promise<EventStreamSlice> {
    const streamName = this.buildStreamName(aggregateType, aggregateId);
    const { fromVersion = 0, maxCount = 100, direction = 'forward' } = options;

    const stream = await this.streamRepository.findOne({
      where: { streamName, tenantId },
    });

    if (!stream) {
      return {
        streamName,
        events: [],
        fromVersion,
        nextVersion: 0,
        isEndOfStream: true,
        streamPosition: { preparePosition: 0, commitPosition: 0 },
      };
    }

    const queryBuilder = this.eventRepository
      .createQueryBuilder('event')
      .where('event.streamName = :streamName', { streamName })
      .andWhere('event.tenantId = :tenantId', { tenantId })
      .andWhere('event.version > :fromVersion', { fromVersion })
      .take(maxCount);

    if (direction === 'forward') {
      queryBuilder.orderBy('event.version', 'ASC');
    } else {
      queryBuilder.orderBy('event.version', 'DESC');
    }

    const events = await queryBuilder.getMany();

    const persistedEvents = events.map((e) => this.toPersistedEvent(e));
    const lastStreamEvent = events[events.length - 1];
    const lastVersion = lastStreamEvent ? lastStreamEvent.version : fromVersion;
    const isEndOfStream = lastVersion >= stream.currentVersion;

    return {
      streamName,
      events: persistedEvents,
      fromVersion,
      nextVersion: lastVersion,
      isEndOfStream,
      streamPosition: {
        preparePosition: lastVersion,
        commitPosition: stream.currentVersion,
      },
    };
  }

  /**
   * Read all events across all streams
   */
  async readAllEvents(
    tenantId: string,
    options: ReadAllOptions = {},
  ): Promise<AllEventsSlice> {
    const {
      fromPosition = 0,
      maxCount = 100,
      direction = 'forward',
      eventTypes,
      aggregateTypes,
      fromDate,
      toDate,
    } = options;

    const queryBuilder = this.eventRepository
      .createQueryBuilder('event')
      .where('event.tenantId = :tenantId', { tenantId })
      .andWhere('event.globalPosition > :fromPosition', { fromPosition })
      .take(maxCount);

    if (eventTypes && eventTypes.length > 0) {
      queryBuilder.andWhere('event.eventType IN (:...eventTypes)', { eventTypes });
    }

    if (aggregateTypes && aggregateTypes.length > 0) {
      queryBuilder.andWhere('event.aggregateType IN (:...aggregateTypes)', {
        aggregateTypes,
      });
    }

    if (fromDate) {
      queryBuilder.andWhere('event.occurredAt >= :fromDate', { fromDate });
    }

    if (toDate) {
      queryBuilder.andWhere('event.occurredAt <= :toDate', { toDate });
    }

    if (direction === 'forward') {
      queryBuilder.orderBy('event.globalPosition', 'ASC');
    } else {
      queryBuilder.orderBy('event.globalPosition', 'DESC');
    }

    const events = await queryBuilder.getMany();

    const persistedEvents = events.map((e) => this.toPersistedEvent(e));
    const lastEvent = events[events.length - 1];
    const lastPosition = lastEvent ? Number(lastEvent.globalPosition) : fromPosition;

    // Check if we've reached the end
    const countAfter = await this.eventRepository.count({
      where: {
        tenantId,
        globalPosition: MoreThan(lastPosition),
      },
    });

    return {
      events: persistedEvents,
      fromPosition,
      nextPosition: lastPosition,
      isEndOfAll: countAfter === 0,
    };
  }

  /**
   * Get stream information
   */
  async getStreamInfo(
    tenantId: string,
    aggregateType: string,
    aggregateId: string,
  ): Promise<EventStream | null> {
    const streamName = this.buildStreamName(aggregateType, aggregateId);
    return this.streamRepository.findOne({
      where: { streamName, tenantId },
    });
  }

  /**
   * Check concurrency
   */
  async checkConcurrency(
    tenantId: string,
    aggregateType: string,
    aggregateId: string,
    expectedVersion: number,
  ): Promise<ConcurrencyCheckResult> {
    const stream = await this.getStreamInfo(tenantId, aggregateType, aggregateId);
    const currentVersion = stream?.currentVersion ?? 0;

    if (expectedVersion === -1 || expectedVersion === currentVersion) {
      return {
        valid: true,
        currentVersion,
        expectedVersion,
      };
    }

    // Get conflicting events
    const conflictingEvents = await this.eventRepository.find({
      where: {
        streamName: this.buildStreamName(aggregateType, aggregateId),
        tenantId,
        version: MoreThan(expectedVersion),
      },
      order: { version: 'ASC' },
    });

    return {
      valid: false,
      currentVersion,
      expectedVersion,
      conflictingEvents: conflictingEvents.map((e) => this.toPersistedEvent(e)),
    };
  }

  /**
   * Create a snapshot
   */
  async createSnapshot(
    tenantId: string,
    aggregateType: string,
    aggregateId: string,
    version: number,
    state: Record<string, unknown>,
    schemaVersion: number = 1,
  ): Promise<Snapshot> {
    // Delete existing snapshot if any
    await this.snapshotRepository.delete({
      aggregateType,
      aggregateId,
      tenantId,
    });

    const snapshot = this.snapshotRepository.create({
      aggregateType,
      aggregateId,
      version,
      state,
      tenantId,
      schemaVersion,
    });

    const saved = await this.snapshotRepository.save(snapshot);
    this.logger.log(
      `Created snapshot for ${aggregateType}/${aggregateId} at version ${version}`,
    );
    return saved;
  }

  /**
   * Get latest snapshot
   */
  async getSnapshot(
    tenantId: string,
    aggregateType: string,
    aggregateId: string,
  ): Promise<SnapshotData | null> {
    const snapshot = await this.snapshotRepository.findOne({
      where: { aggregateType, aggregateId, tenantId },
    });

    if (!snapshot) {
      return null;
    }

    return {
      aggregateType: snapshot.aggregateType,
      aggregateId: snapshot.aggregateId,
      version: snapshot.version,
      state: snapshot.state,
      tenantId: snapshot.tenantId,
      createdAt: snapshot.createdAt,
      schemaVersion: snapshot.schemaVersion,
    };
  }

  /**
   * Load aggregate from snapshot + events
   */
  async loadAggregate(
    tenantId: string,
    aggregateType: string,
    aggregateId: string,
  ): Promise<{
    snapshot: SnapshotData | null;
    events: PersistedEvent[];
    currentVersion: number;
  }> {
    const snapshot = await this.getSnapshot(tenantId, aggregateType, aggregateId);
    const fromVersion = snapshot?.version ?? 0;

    const slice = await this.readStream(tenantId, aggregateType, aggregateId, {
      fromVersion,
      maxCount: 10000,
    });

    return {
      snapshot,
      events: slice.events,
      currentVersion: slice.streamPosition.commitPosition,
    };
  }

  /**
   * Delete a stream (soft delete)
   */
  async deleteStream(
    tenantId: string,
    aggregateType: string,
    aggregateId: string,
  ): Promise<void> {
    const streamName = this.buildStreamName(aggregateType, aggregateId);
    const stream = await this.streamRepository.findOne({
      where: { streamName, tenantId },
    });

    if (!stream) {
      throw new NotFoundException(`Stream ${streamName} not found`);
    }

    stream.isDeleted = true;
    await this.streamRepository.save(stream);

    this.logger.log(`Soft deleted stream ${streamName}`);
  }

  /**
   * Get event store statistics
   */
  async getStatistics(tenantId: string): Promise<{
    totalEvents: number;
    totalStreams: number;
    totalSnapshots: number;
    eventsLast24h: number;
    eventsByType: Record<string, number>;
    eventsByAggregate: Record<string, number>;
  }> {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    const [
      totalEvents,
      totalStreams,
      totalSnapshots,
      eventsLast24h,
      eventsByType,
      eventsByAggregate,
    ] = await Promise.all([
      this.eventRepository.count({ where: { tenantId } }),
      this.streamRepository.count({ where: { tenantId, isDeleted: false } }),
      this.snapshotRepository.count({ where: { tenantId } }),
      this.eventRepository.count({
        where: { tenantId, storedAt: MoreThan(yesterday) },
      }),
      this.eventRepository
        .createQueryBuilder('e')
        .select('e.eventType', 'eventType')
        .addSelect('COUNT(*)', 'count')
        .where('e.tenantId = :tenantId', { tenantId })
        .groupBy('e.eventType')
        .getRawMany(),
      this.eventRepository
        .createQueryBuilder('e')
        .select('e.aggregateType', 'aggregateType')
        .addSelect('COUNT(*)', 'count')
        .where('e.tenantId = :tenantId', { tenantId })
        .groupBy('e.aggregateType')
        .getRawMany(),
    ]);

    return {
      totalEvents,
      totalStreams,
      totalSnapshots,
      eventsLast24h,
      eventsByType: eventsByType.reduce(
        (acc, row) => ({ ...acc, [row.eventType]: parseInt(row.count, 10) }),
        {},
      ),
      eventsByAggregate: eventsByAggregate.reduce(
        (acc, row) => ({ ...acc, [row.aggregateType]: parseInt(row.count, 10) }),
        {},
      ),
    };
  }

  /**
   * Search events with pagination
   */
  async searchEvents(
    tenantId: string,
    criteria: {
      eventType?: string;
      aggregateType?: string;
      aggregateId?: string;
      correlationId?: string;
      userId?: string;
      fromDate?: Date;
      toDate?: Date;
    },
    pagination: { page: number; limit: number },
    sorting: { field: string; order: 'ASC' | 'DESC' },
  ): Promise<{
    events: PersistedEvent[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const where: FindOptionsWhere<StoredEvent> = { tenantId };

    if (criteria.eventType) {
      where.eventType = criteria.eventType;
    }
    if (criteria.aggregateType) {
      where.aggregateType = criteria.aggregateType;
    }
    if (criteria.aggregateId) {
      where.aggregateId = criteria.aggregateId;
    }
    if (criteria.correlationId) {
      where.correlationId = criteria.correlationId;
    }
    if (criteria.userId) {
      where.userId = criteria.userId;
    }

    const queryBuilder = this.eventRepository
      .createQueryBuilder('event')
      .where(where);

    if (criteria.fromDate && criteria.toDate) {
      queryBuilder.andWhere('event.occurredAt BETWEEN :fromDate AND :toDate', {
        fromDate: criteria.fromDate,
        toDate: criteria.toDate,
      });
    } else if (criteria.fromDate) {
      queryBuilder.andWhere('event.occurredAt >= :fromDate', {
        fromDate: criteria.fromDate,
      });
    } else if (criteria.toDate) {
      queryBuilder.andWhere('event.occurredAt <= :toDate', {
        toDate: criteria.toDate,
      });
    }

    const [events, total] = await queryBuilder
      .orderBy(`event.${sorting.field}`, sorting.order)
      .skip((pagination.page - 1) * pagination.limit)
      .take(pagination.limit)
      .getManyAndCount();

    return {
      events: events.map((e) => this.toPersistedEvent(e)),
      total,
      page: pagination.page,
      limit: pagination.limit,
      totalPages: Math.ceil(total / pagination.limit),
    };
  }

  /**
   * Build stream name from aggregate type and id
   */
  private buildStreamName(aggregateType: string, aggregateId: string): string {
    return `${aggregateType}-${aggregateId}`;
  }

  /**
   * Convert stored event entity to persisted event interface
   */
  private toPersistedEvent(event: StoredEvent): PersistedEvent {
    return {
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
    };
  }
}
