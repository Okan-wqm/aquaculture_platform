import {
  Injectable,
  Logger,
  ConflictException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { Repository, DataSource, MoreThan, FindOptionsWhere, QueryRunner } from 'typeorm';
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

const ALLOWED_SORT_FIELDS = new Set(['occurredAt', 'storedAt', 'globalPosition']);
const AGGREGATE_TYPE_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const MAX_LOAD_AGGREGATE_EVENTS = 1000;
const MAX_APPEND_EVENTS = 100;
const MAX_PAYLOAD_BYTES = 256 * 1024;
const MAX_METADATA_BYTES = 64 * 1024;
const MAX_JSON_DEPTH = 32;

interface AppendIdempotencyOptions {
  producer?: string;
  idempotencyKey?: string;
}

function stableJson(value: unknown): string {
  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort((a, b) => a.localeCompare(b))
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

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
    idempotency: AppendIdempotencyOptions = {},
  ): Promise<AppendResult> {
    this.validateAggregateType(aggregateType);
    this.validateAppendBatch(events, idempotency);
    const streamName = this.buildStreamName(aggregateType, aggregateId);
    const requestHash = this.appendRequestHash(
      tenantId,
      streamName,
      expectedVersion,
      events,
    );
    const queryRunner = this.dataSource.createQueryRunner();

    await queryRunner.connect();
    await queryRunner.startTransaction('READ COMMITTED');

    try {
      const replay = await this.reserveAppendIdempotency(
        queryRunner,
        tenantId,
        idempotency,
        requestHash,
      );
      if (replay) {
        await queryRunner.commitTransaction();
        return replay;
      }

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

      const positions = await this.allocateCommitSafeGlobalPositions(
        queryRunner,
        events.length,
      );

      // Build all events for bulk insert
      const storedEvents: Array<Record<string, unknown>> = [];
      for (let i = 0; i < events.length; i++) {
        const event = events[i]!;
        newVersion++;
        const globalPosition = positions[i]!;

        storedEvents.push({
          producer: idempotency.producer ?? null,
          producerEventId: event.producerEventId ?? null,
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

        globalPositions.push(globalPosition);
      }

      // Bulk insert all events
      const insertResult = await queryRunner.manager.insert(StoredEvent, storedEvents);
      for (const row of insertResult.identifiers) {
        eventIds.push(row['id']);
      }

      // Update stream metadata
      stream.currentVersion = newVersion;
      stream.eventCount = stream.eventCount + events.length;
      stream.lastEventAt = new Date();
      await queryRunner.manager.save(stream);

      const appendResult = {
        success: true,
        streamName,
        newVersion,
        eventIds,
        globalPositions,
      };

      await this.completeAppendIdempotency(
        queryRunner,
        tenantId,
        idempotency,
        requestHash,
        appendResult,
      );

      await queryRunner.commitTransaction();

      this.logger.log(
        `Appended ${events.length} events to stream ${streamName}, new version: ${newVersion}`,
      );

      return appendResult;
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

    const currentSnapshot = await this.snapshotRepository.findOne({
      where: { aggregateType, aggregateId, tenantId },
    });

    if (currentSnapshot && version < currentSnapshot.version) {
      throw new ConflictException(
        `Snapshot version ${version} is older than current snapshot version ${currentSnapshot.version}`,
      );
    }

    if (currentSnapshot) {
      currentSnapshot.version = version;
      currentSnapshot.state = state;
      currentSnapshot.schemaVersion = schemaVersion;
      await this.snapshotRepository.save(currentSnapshot);
    } else {
      await this.snapshotRepository.save(
        this.snapshotRepository.create({
          aggregateType,
          aggregateId,
          tenantId,
          version,
          state,
          schemaVersion,
        }),
      );
    }

    const snapshot = await this.snapshotRepository.findOneOrFail({
      where: { aggregateType, aggregateId, tenantId },
    });

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

    if (!slice.isEndOfStream) {
      throw new BadRequestException(
        `loadAggregate for ${aggregateType}/${aggregateId} is incomplete after ` +
          `${MAX_LOAD_AGGREGATE_EVENTS} events. Create a newer snapshot or use a paginated replay API.`,
      );
    }

    return {
      snapshot,
      events: slice.events,
      currentVersion: slice.streamPosition.commitPosition,
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

    stream.isDeleted = true;
    await this.streamRepository.save(stream);

    // Cascade: delete associated snapshot
    await this.snapshotRepository.delete({
      aggregateType,
      aggregateId,
      tenantId,
    });

    this.logger.log(`Soft deleted stream ${streamName} and associated snapshot`);
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

  private validateAppendBatch(
    events: DomainEvent[],
    idempotency: AppendIdempotencyOptions,
  ): void {
    if (events.length === 0) {
      throw new BadRequestException('appendToStream requires at least one event');
    }
    if (events.length > MAX_APPEND_EVENTS) {
      throw new BadRequestException(
        `appendToStream accepts at most ${MAX_APPEND_EVENTS} events per request`,
      );
    }

    const hasProducer = !!idempotency.producer;
    for (const event of events) {
      if (hasProducer && !event.producerEventId) {
        throw new BadRequestException(
          'producerEventId is required for every event when producer is provided',
        );
      }
      if (!hasProducer && event.producerEventId) {
        throw new BadRequestException(
          'producerEventId requires producer on the append request',
        );
      }
      this.validateJsonPayload('payload', event.payload, MAX_PAYLOAD_BYTES);
      if (event.metadata) {
        this.validateJsonPayload('metadata', event.metadata, MAX_METADATA_BYTES);
      }
    }
  }

  private validateJsonPayload(
    label: string,
    value: Record<string, unknown>,
    maxBytes: number,
  ): void {
    const encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded, 'utf8') > maxBytes) {
      throw new BadRequestException(`${label} exceeds ${maxBytes} bytes`);
    }
    if (this.jsonDepth(value) > MAX_JSON_DEPTH) {
      throw new BadRequestException(
        `${label} exceeds maximum JSON depth ${MAX_JSON_DEPTH}`,
      );
    }
  }

  private jsonDepth(value: unknown): number {
    if (value === null || typeof value !== 'object') return 0;
    if (Array.isArray(value)) {
      return 1 + Math.max(0, ...value.map((item) => this.jsonDepth(item)));
    }
    return (
      1 +
      Math.max(
        0,
        ...Object.values(value as Record<string, unknown>).map((item) =>
          this.jsonDepth(item),
        ),
      )
    );
  }

  private appendRequestHash(
    tenantId: string,
    streamName: string,
    expectedVersion: number,
    events: DomainEvent[],
  ): string {
    return createHash('sha256')
      .update(stableJson({ tenantId, streamName, expectedVersion, events }))
      .digest('hex');
  }

  private async reserveAppendIdempotency(
    queryRunner: QueryRunner,
    tenantId: string,
    idempotency: AppendIdempotencyOptions,
    requestHash: string,
  ): Promise<AppendResult | null> {
    const { producer, idempotencyKey } = idempotency;
    if (!producer && !idempotencyKey) return null;
    if (!producer || !idempotencyKey) {
      throw new BadRequestException(
        'producer and idempotencyKey must be provided together',
      );
    }

    const inserted = await queryRunner.manager.query(
      `
        INSERT INTO "event_store"."append_idempotency"
          ("tenantId", "producer", "idempotencyKey", "requestHash", "status")
        VALUES ($1, $2, $3, $4, 'started')
        ON CONFLICT ("tenantId", "producer", "idempotencyKey") DO NOTHING
        RETURNING "id"
      `,
      [tenantId, producer, idempotencyKey, requestHash],
    );

    if (inserted.length > 0) return null;

    const rows = await queryRunner.manager.query(
      `
        SELECT "requestHash", "status", "result"
        FROM "event_store"."append_idempotency"
        WHERE "tenantId" = $1
          AND "producer" = $2
          AND "idempotencyKey" = $3
        FOR UPDATE
      `,
      [tenantId, producer, idempotencyKey],
    );
    const row = rows[0] as
      | { requestHash: string; status: string; result: AppendResult | null }
      | undefined;

    if (!row) {
      throw new ConflictException('Idempotency reservation disappeared');
    }
    if (row.requestHash !== requestHash) {
      throw new ConflictException(
        'Idempotency key was reused with a different append request',
      );
    }
    if (row.status === 'completed' && row.result) {
      return row.result;
    }

    throw new ConflictException(
      'Idempotent append request is already in progress',
    );
  }

  private async completeAppendIdempotency(
    queryRunner: QueryRunner,
    tenantId: string,
    idempotency: AppendIdempotencyOptions,
    requestHash: string,
    result: AppendResult,
  ): Promise<void> {
    if (!idempotency.producer || !idempotency.idempotencyKey) return;

    await queryRunner.manager.query(
      `
        UPDATE "event_store"."append_idempotency"
        SET "status" = 'completed',
            "result" = $5::jsonb,
            "updatedAt" = now()
        WHERE "tenantId" = $1
          AND "producer" = $2
          AND "idempotencyKey" = $3
          AND "requestHash" = $4
      `,
      [
        tenantId,
        idempotency.producer,
        idempotency.idempotencyKey,
        requestHash,
        JSON.stringify(result),
      ],
    );
  }

  private async allocateCommitSafeGlobalPositions(
    queryRunner: QueryRunner,
    count: number,
  ): Promise<number[]> {
    await queryRunner.manager.query(
      `
        INSERT INTO "event_store"."ledger_cursors" ("name", "nextPosition")
        VALUES ('global', COALESCE((SELECT max("globalPosition") FROM "event_store"."stored_events"), 0))
        ON CONFLICT ("name") DO NOTHING
      `,
    );

    const rows = await queryRunner.manager.query(
      `
        SELECT "nextPosition"
        FROM "event_store"."ledger_cursors"
        WHERE "name" = 'global'
        FOR UPDATE
      `,
    );
    const current = Number(rows[0]?.nextPosition ?? 0);
    const next = current + count;

    await queryRunner.manager.query(
      `
        UPDATE "event_store"."ledger_cursors"
        SET "nextPosition" = $1,
            "updatedAt" = now()
        WHERE "name" = 'global'
      `,
      [next],
    );

    return Array.from({ length: count }, (_, index) => current + index + 1);
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
      producer: event.producer ?? undefined,
      producerEventId: event.producerEventId ?? undefined,
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
}
