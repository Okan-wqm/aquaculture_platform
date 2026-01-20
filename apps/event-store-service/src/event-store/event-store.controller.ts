import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
  Headers,
  BadRequestException,
} from '@nestjs/common';
import { EventStoreService } from './services/event-store.service';
import {
  AppendEventsDto,
  ReadStreamDto,
  ReadAllEventsDto,
  SearchEventsDto,
  CreateSnapshotDto,
  StreamInfoDto,
  EventStoreStatsDto,
} from './dto/event-store.dto';
import {
  AppendResult,
  EventStreamSlice,
  AllEventsSlice,
  PersistedEvent,
  SnapshotData,
  ConcurrencyCheckResult,
} from './interfaces/event-store.interfaces';

@Controller('events')
export class EventStoreController {
  constructor(private readonly eventStoreService: EventStoreService) {}

  /**
   * Append events to a stream
   */
  @Post('streams/:aggregateType/:aggregateId')
  @HttpCode(HttpStatus.CREATED)
  async appendEvents(
    @Headers('x-tenant-id') tenantId: string,
    @Param('aggregateType') aggregateType: string,
    @Param('aggregateId', ParseUUIDPipe) aggregateId: string,
    @Body() dto: AppendEventsDto,
  ): Promise<AppendResult> {
    this.validateTenantId(tenantId);

    return this.eventStoreService.appendToStream(
      tenantId,
      dto.aggregateType || aggregateType,
      dto.aggregateId || aggregateId,
      dto.events.map((e) => ({
        eventType: e.eventType,
        payload: e.payload,
        metadata: e.metadata,
        correlationId: e.correlationId,
        causationId: e.causationId,
        userId: e.userId,
        occurredAt: e.occurredAt ? new Date(e.occurredAt) : new Date(),
        schemaVersion: e.schemaVersion,
      })),
      dto.expectedVersion,
    );
  }

  /**
   * Read events from a specific stream
   */
  @Get('streams/:aggregateType/:aggregateId')
  async readStream(
    @Headers('x-tenant-id') tenantId: string,
    @Param('aggregateType') aggregateType: string,
    @Param('aggregateId', ParseUUIDPipe) aggregateId: string,
    @Query() query: ReadStreamDto,
  ): Promise<EventStreamSlice> {
    this.validateTenantId(tenantId);

    return this.eventStoreService.readStream(tenantId, aggregateType, aggregateId, {
      fromVersion: query.fromVersion,
      maxCount: query.maxCount,
      direction: query.direction,
    });
  }

  /**
   * Get stream information
   */
  @Get('streams/:aggregateType/:aggregateId/info')
  async getStreamInfo(
    @Headers('x-tenant-id') tenantId: string,
    @Param('aggregateType') aggregateType: string,
    @Param('aggregateId', ParseUUIDPipe) aggregateId: string,
  ): Promise<StreamInfoDto | { message: string }> {
    this.validateTenantId(tenantId);

    const stream = await this.eventStoreService.getStreamInfo(
      tenantId,
      aggregateType,
      aggregateId,
    );

    if (!stream) {
      return { message: 'Stream not found' };
    }

    const snapshot = await this.eventStoreService.getSnapshot(
      tenantId,
      aggregateType,
      aggregateId,
    );

    return {
      streamName: stream.streamName,
      aggregateType: stream.aggregateType,
      aggregateId: stream.aggregateId,
      currentVersion: stream.currentVersion,
      eventCount: Number(stream.eventCount),
      createdAt: stream.createdAt,
      lastEventAt: stream.lastEventAt,
      hasSnapshot: !!snapshot,
      snapshotVersion: snapshot?.version,
    };
  }

  /**
   * Check concurrency for a stream
   */
  @Get('streams/:aggregateType/:aggregateId/concurrency')
  async checkConcurrency(
    @Headers('x-tenant-id') tenantId: string,
    @Param('aggregateType') aggregateType: string,
    @Param('aggregateId', ParseUUIDPipe) aggregateId: string,
    @Query('expectedVersion') expectedVersion: number,
  ): Promise<ConcurrencyCheckResult> {
    this.validateTenantId(tenantId);

    return this.eventStoreService.checkConcurrency(
      tenantId,
      aggregateType,
      aggregateId,
      expectedVersion,
    );
  }

  /**
   * Delete a stream (soft delete)
   */
  @Delete('streams/:aggregateType/:aggregateId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteStream(
    @Headers('x-tenant-id') tenantId: string,
    @Param('aggregateType') aggregateType: string,
    @Param('aggregateId', ParseUUIDPipe) aggregateId: string,
  ): Promise<void> {
    this.validateTenantId(tenantId);

    await this.eventStoreService.deleteStream(tenantId, aggregateType, aggregateId);
  }

  /**
   * Read all events (global)
   */
  @Get()
  async readAllEvents(
    @Headers('x-tenant-id') tenantId: string,
    @Query() query: ReadAllEventsDto,
  ): Promise<AllEventsSlice> {
    this.validateTenantId(tenantId);

    return this.eventStoreService.readAllEvents(tenantId, {
      fromPosition: query.fromPosition,
      maxCount: query.maxCount,
      direction: query.direction,
      eventTypes: query.eventType ? [query.eventType] : undefined,
      aggregateTypes: query.aggregateType ? [query.aggregateType] : undefined,
      fromDate: query.fromDate ? new Date(query.fromDate) : undefined,
      toDate: query.toDate ? new Date(query.toDate) : undefined,
    });
  }

  /**
   * Search events with filters
   */
  @Get('search')
  async searchEvents(
    @Headers('x-tenant-id') tenantId: string,
    @Query() query: SearchEventsDto,
  ): Promise<{
    events: PersistedEvent[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    this.validateTenantId(tenantId);

    return this.eventStoreService.searchEvents(
      tenantId,
      {
        eventType: query.eventType,
        aggregateType: query.aggregateType,
        aggregateId: query.aggregateId,
        correlationId: query.correlationId,
        userId: query.userId,
        fromDate: query.fromDate ? new Date(query.fromDate) : undefined,
        toDate: query.toDate ? new Date(query.toDate) : undefined,
      },
      {
        page: query.page || 1,
        limit: query.limit || 20,
      },
      {
        field: query.sortBy || 'globalPosition',
        order: query.sortOrder || 'ASC',
      },
    );
  }

  /**
   * Get event store statistics
   */
  @Get('stats')
  async getStatistics(
    @Headers('x-tenant-id') tenantId: string,
  ): Promise<EventStoreStatsDto> {
    this.validateTenantId(tenantId);

    const stats = await this.eventStoreService.getStatistics(tenantId);
    return {
      ...stats,
      storageUsedMb: 0, // Would need to query actual storage
    };
  }

  /**
   * Create a snapshot
   */
  @Post('snapshots')
  @HttpCode(HttpStatus.CREATED)
  async createSnapshot(
    @Headers('x-tenant-id') tenantId: string,
    @Body() dto: CreateSnapshotDto,
  ): Promise<SnapshotData> {
    this.validateTenantId(tenantId);

    const snapshot = await this.eventStoreService.createSnapshot(
      tenantId,
      dto.aggregateType,
      dto.aggregateId,
      dto.version,
      dto.state,
      dto.schemaVersion,
    );

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
   * Get snapshot for an aggregate
   */
  @Get('snapshots/:aggregateType/:aggregateId')
  async getSnapshot(
    @Headers('x-tenant-id') tenantId: string,
    @Param('aggregateType') aggregateType: string,
    @Param('aggregateId', ParseUUIDPipe) aggregateId: string,
  ): Promise<SnapshotData | { message: string }> {
    this.validateTenantId(tenantId);

    const snapshot = await this.eventStoreService.getSnapshot(
      tenantId,
      aggregateType,
      aggregateId,
    );

    if (!snapshot) {
      return { message: 'Snapshot not found' };
    }

    return snapshot;
  }

  /**
   * Load aggregate from snapshot + events
   */
  @Get('aggregates/:aggregateType/:aggregateId')
  async loadAggregate(
    @Headers('x-tenant-id') tenantId: string,
    @Param('aggregateType') aggregateType: string,
    @Param('aggregateId', ParseUUIDPipe) aggregateId: string,
  ): Promise<{
    snapshot: SnapshotData | null;
    events: PersistedEvent[];
    currentVersion: number;
  }> {
    this.validateTenantId(tenantId);

    return this.eventStoreService.loadAggregate(tenantId, aggregateType, aggregateId);
  }

  private validateTenantId(tenantId: string): void {
    if (!tenantId) {
      throw new BadRequestException('X-Tenant-Id header is required');
    }
  }
}
