import { createHash } from 'crypto';

import {
  Injectable,
  Logger,
  ConflictException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import {
  Repository,
  DataSource,
  MoreThan,
  FindOptionsWhere,
  EntityManager,
  Brackets,
} from 'typeorm';

import { EventStream } from '../entities/event-stream.entity';
import { Snapshot } from '../entities/snapshot.entity';
import { StoredEvent } from '../entities/stored-event.entity';
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

const ALLOWED_SORT_FIELDS = new Set(['occurredAt', 'storedAt', 'globalPosition']);
const AGGREGATE_TYPE_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const MAX_LOAD_AGGREGATE_EVENTS = 1000;
const MAX_APPEND_EVENTS = 100;

@Injectable()
export class EventStoreService {
  private readonly logger = new Logger(EventStoreService.name);
  private readonly statsCache = new Map<string, { data: unknown; expiresAt: number }>();

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
    this.validateAggregateType(aggregateType);
    this.validateAppendEvents(events);
    const streamName = this.buildStreamName(aggregateType, aggregateId);
    const queryRunner = this.dataSource.createQueryRunner();

    await queryRunner.connect();
    await queryRunner.startTransaction('READ COMMITTED');

    try {
      // Get or create stream with lock
      let stream = await queryRunner.manager.findOne(EventStream, {
        where: { streamName, tenantId },
        lock: { mode: 'pessimistic_write' },
      });

      // Reject appends to soft-deleted streams
      if (stream?.isDeleted) {
        throw new ConflictException(`Stream ${streamName} has been deleted`);
      }

      const currentVersion = stream?.currentVersion ?? 0;

      // Concurrency check
      if (expectedVersion !== -1 && expectedVersion !== currentVersion) {
        throw new ConflictException(
          `Concurrency conflict: expected version ${expectedVersion}, but current version is ${currentVersion}`,
        );
      }

      const duplicateEvents = await this.findExistingProducerEvents(
        queryRunner.manager,
        tenantId,
        events,
      );
      if (duplicateEvents.length > 0) {
        if (
          duplicateEvents.length === events.length &&
          this.isExactIdempotentReplay(duplicateEvents, streamName, events)
        ) {
          await queryRunner.commitTransaction();
          const byProducerEventId = new Map(
            duplicateEvents.map((event) => [event.producerEventId, event]),
          );
          const replayedEvents = events.map((event) => {
            const replayedEvent = byProducerEventId.get(event.producerEventId);
            if (!replayedEvent) {
              throw new ConflictException(
                `Producer event ${event.producerEventId} was not found in the idempotent replay set`,
              );
            }
            return replayedEvent;
          });
          return {
            success: true,
            streamName,
            newVersion: currentVersion,
            eventIds: replayedEvents.map((event) => event.id),
            globalPositions: replayedEvents.map((event) => event.globalPosition),
          };
        }

        throw new ConflictException(
          'Producer event idempotency conflict: producerEventId already exists with different event content',
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
      const globalPositions: string[] = [];
      let newVersion = currentVersion;

      // Build all events for bulk insert
      const storedEvents: Array<Record<string, unknown>> = [];
      for (let i = 0; i < events.length; i++) {
        const event = events[i]!;
        newVersion++;

        storedEvents.push({
          streamName,
          streamPosition: newVersion.toString(),
          producer: event.producer,
          producerEventId: event.producerEventId,
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
      }

      // Bulk insert all events
      const insertResult = await queryRunner.manager
        .createQueryBuilder()
        .insert()
        .into(StoredEvent)
        .values(storedEvents)
        .returning(['id', 'globalPosition'])
        .execute();
      for (const row of insertResult.raw as Array<Record<string, unknown>>) {
        eventIds.push(String(row['id']));
        globalPositions.push(String(row['globalPosition'] ?? row['globalposition']));
      }

      // Update stream metadata
      stream.currentVersion = newVersion;
      stream.eventCount = stream.eventCount + events.length;
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

      // Retry on serialization failure (PostgreSQL error code 40001)
      const pgError = error as { code?: string };
      if (pgError.code === '40001') {
        this.logger.warn(
          `Serialization failure on stream ${streamName}, caller should retry`,
        );
        throw new ConflictException(
          'Concurrent write conflict, please retry the operation',
        );
      }

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
      where: { streamName, tenantId, isDeleted: false },
    });

    if (!stream) {
      return {
        streamName,
        events: [],
        fromVersion,
        nextVersion: 0,
        isEndOfStream: true,
        streamPosition: { preparePosition: '0', commitPosition: '0' },
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
        preparePosition: lastVersion.toString(),
        commitPosition: stream.currentVersion.toString(),
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
      fromPosition = '0',
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
    const lastPosition = lastEvent ? lastEvent.globalPosition : fromPosition;

    return {
      events: persistedEvents,
      fromPosition,
      nextPosition: lastPosition,
      isEndOfAll: events.length < maxCount,
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
   * Create a snapshot with atomic upsert and version validation
   */
  async createSnapshot(
    tenantId: string,
    aggregateType: string,
    aggregateId: string,
    version: number,
    state: Record<string, unknown>,
    schemaVersion: number = 1,
  ): Promise<Snapshot> {
    // Verify stream exists and version is valid
    const streamName = this.buildStreamName(aggregateType, aggregateId);
    const stream = await this.streamRepository.findOne({
      where: { streamName, tenantId, isDeleted: false },
    });

    if (!stream) {
      throw new NotFoundException(
        `Stream ${aggregateType}/${aggregateId} not found`,
      );
    }

    if (version > stream.currentVersion) {
      throw new BadRequestException(
        `Snapshot version ${version} exceeds stream current version ${stream.currentVersion}`,
      );
    }

    const stateHash = this.hashJson(state);
    const existingSnapshot = await this.snapshotRepository.findOne({
      where: { aggregateType, aggregateId, tenantId, version },
    });

    if (existingSnapshot) {
      if (existingSnapshot.stateHash === stateHash) {
        return existingSnapshot;
      }
      throw new ConflictException(
        `Snapshot ${aggregateType}/${aggregateId}@${version} already exists with different state`,
      );
    }

    const snapshot = await this.snapshotRepository.save(
      this.snapshotRepository.create({
        aggregateType,
        aggregateId,
        tenantId,
        version,
        state,
        stateHash,
        schemaVersion,
      }),
    );

    this.logger.log(
      `Created snapshot for ${aggregateType}/${aggregateId} at version ${version}`,
    );
    return snapshot;
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
      order: { version: 'DESC' },
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
   * Load aggregate from snapshot + events with pagination ceiling
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
      maxCount: MAX_LOAD_AGGREGATE_EVENTS,
    });

    if (slice.events.length === MAX_LOAD_AGGREGATE_EVENTS) {
      this.logger.warn(
        `loadAggregate for ${aggregateType}/${aggregateId} hit the ${MAX_LOAD_AGGREGATE_EVENTS} event ceiling. ` +
          `Consider creating a snapshot to reduce replay size.`,
      );
    }

    return {
      snapshot,
      events: slice.events,
      currentVersion: Number(slice.streamPosition.commitPosition),
    };
  }

  /**
   * Delete a stream (soft delete) and cascade to snapshots
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

    if (stream.isDeleted) {
      return;
    }

    await this.appendToStream(
      tenantId,
      aggregateType,
      aggregateId,
      [
        {
          producer: 'event-store-service',
          producerEventId: `stream-delete:${tenantId}:${streamName}:${stream.currentVersion + 1}`,
          eventType: 'StreamDeleted',
          payload: {
            aggregateType,
            aggregateId,
            streamName,
            deletedAt: new Date().toISOString(),
          },
          metadata: { tombstone: true },
          occurredAt: new Date(),
          schemaVersion: 1,
        },
      ],
      stream.currentVersion,
    );

    await this.streamRepository.update(
      { id: stream.id, tenantId, isDeleted: false },
      { isDeleted: true },
    );

    this.logger.log(`Tombstoned stream ${streamName}`);
  }

  /**
   * Get event store statistics (with TTL cache)
   */
  async getStatistics(tenantId: string): Promise<{
    totalEvents: number;
    totalStreams: number;
    totalSnapshots: number;
    eventsLast24h: number;
    eventsByType: Record<string, number>;
    eventsByAggregate: Record<string, number>;
  }> {
    const cacheKey = `stats:${tenantId}`;
    const cached = this.statsCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data as Awaited<ReturnType<EventStoreService['getStatistics']>>;
    }

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

    const result = {
      totalEvents,
      totalStreams,
      totalSnapshots,
      eventsLast24h,
      eventsByType: eventsByType.reduce(
        (acc: Record<string, number>, row: { eventType: string; count: string }) => ({
          ...acc,
          [row.eventType]: parseInt(row.count, 10),
        }),
        {},
      ),
      eventsByAggregate: eventsByAggregate.reduce(
        (acc: Record<string, number>, row: { aggregateType: string; count: string }) => ({
          ...acc,
          [row.aggregateType]: parseInt(row.count, 10),
        }),
        {},
      ),
    };

    // Cache for 60 seconds
    this.statsCache.set(cacheKey, { data: result, expiresAt: Date.now() + 60_000 });

    return result;
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
    // Validate sort field against allowlist to prevent SQL injection
    if (!ALLOWED_SORT_FIELDS.has(sorting.field)) {
      throw new BadRequestException(`Invalid sort field: ${sorting.field}`);
    }

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
      .offset((pagination.page - 1) * pagination.limit)
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
   * Validate aggregate type against an allowlist pattern
   */
  private validateAggregateType(aggregateType: string): void {
    if (!AGGREGATE_TYPE_PATTERN.test(aggregateType)) {
      throw new BadRequestException(
        `Invalid aggregate type: ${aggregateType}. Must match pattern: ^[A-Za-z][A-Za-z0-9]{0,63}$`,
      );
    }
  }

  private validateAppendEvents(events: DomainEvent[]): void {
    if (events.length === 0) {
      throw new BadRequestException('At least one event is required');
    }
    if (events.length > MAX_APPEND_EVENTS) {
      throw new BadRequestException(`Cannot append more than ${MAX_APPEND_EVENTS} events at once`);
    }
    for (const event of events) {
      if (!event.producer || !event.producerEventId) {
        throw new BadRequestException('producer and producerEventId are required for every event');
      }
    }
  }

  private async findExistingProducerEvents(
    manager: EntityManager,
    tenantId: string,
    events: DomainEvent[],
  ): Promise<StoredEvent[]> {
    const query = manager
      .createQueryBuilder(StoredEvent, 'event')
      .where('event.tenantId = :tenantId', { tenantId });

    query.andWhere(
      new Brackets((scoped) => {
        events.forEach((event, index) => {
          const condition = `(event.producer = :producer${index} AND event.producerEventId = :producerEventId${index})`;
          const params = {
            [`producer${index}`]: event.producer,
            [`producerEventId${index}`]: event.producerEventId,
          };
          if (index === 0) {
            scoped.where(condition, params);
          } else {
            scoped.orWhere(condition, params);
          }
        });
      }),
    );

    return query.getMany();
  }

  private isExactIdempotentReplay(
    existingEvents: StoredEvent[],
    streamName: string,
    requestedEvents: DomainEvent[],
  ): boolean {
    const byProducerEventId = new Map(
      existingEvents.map((event) => [event.producerEventId, event]),
    );

    return requestedEvents.every((requested) => {
      const existing = byProducerEventId.get(requested.producerEventId);
      return (
        existing !== undefined &&
        existing.streamName === streamName &&
        existing.producer === requested.producer &&
        existing.eventType === requested.eventType &&
        this.hashJson(existing.payload) === this.hashJson(requested.payload) &&
        this.hashJson(existing.metadata ?? {}) === this.hashJson(requested.metadata ?? {})
      );
    });
  }

  private hashJson(value: Record<string, unknown>): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
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
    };
  }
}
