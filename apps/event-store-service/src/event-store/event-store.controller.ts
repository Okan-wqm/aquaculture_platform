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
  Req,
  NotFoundException,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import type { TenantRequest } from '@aquaculture/backend-common/types';
import { Type } from 'class-transformer';
import { IsNumber, IsOptional, Min } from 'class-validator';
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

// UUID v4 regex for tenant ID validation (shared with projections controller)
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Aggregate type allowlist pattern — must start with a letter, alphanumeric only, max 64 chars
const AGGREGATE_TYPE_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,63}$/;

class CheckConcurrencyDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(-1)
  expectedVersion?: number;
}

@Controller('events')
export class EventStoreController {
  constructor(private readonly eventStoreService: EventStoreService) {}

  /**
   * Append events to a stream
   */
  @Post('streams/:aggregateType/:aggregateId')
  @HttpCode(HttpStatus.CREATED)
  async appendEvents(
    @Req() request: TenantRequest,
    @Param('aggregateType') aggregateType: string,
    @Param('aggregateId', ParseUUIDPipe) aggregateId: string,
    @Body() dto: AppendEventsDto,
  ): Promise<AppendResult> {
    const validatedTenantId = this.getVerifiedTenantId(request);
    this.validateAggregateType(aggregateType);

    // Use URL path parameters exclusively — ignore body overrides
    return this.eventStoreService.appendToStream(
      validatedTenantId,
      aggregateType,
      aggregateId,
      dto.events.map((e) => ({
        producer: e.producer,
        producerEventId: e.producerEventId,
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
    @Req() request: TenantRequest,
    @Param('aggregateType') aggregateType: string,
    @Param('aggregateId', ParseUUIDPipe) aggregateId: string,
    @Query() query: ReadStreamDto,
  ): Promise<EventStreamSlice> {
    const validatedTenantId = this.getVerifiedTenantId(request);
    this.validateAggregateType(aggregateType);

    return this.eventStoreService.readStream(validatedTenantId, aggregateType, aggregateId, {
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
    @Req() request: TenantRequest,
    @Param('aggregateType') aggregateType: string,
    @Param('aggregateId', ParseUUIDPipe) aggregateId: string,
  ): Promise<StreamInfoDto> {
    const validatedTenantId = this.getVerifiedTenantId(request);
    this.validateAggregateType(aggregateType);

    const stream = await this.eventStoreService.getStreamInfo(
      validatedTenantId,
      aggregateType,
      aggregateId,
    );

    if (!stream) {
      throw new NotFoundException(`Stream ${aggregateType}/${aggregateId} not found`);
    }

    const snapshot = await this.eventStoreService.getSnapshot(
      validatedTenantId,
      aggregateType,
      aggregateId,
    );

    return {
      streamName: stream.streamName,
      aggregateType: stream.aggregateType,
      aggregateId: stream.aggregateId,
      currentVersion: stream.currentVersion,
      eventCount: stream.eventCount,
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
    @Req() request: TenantRequest,
    @Param('aggregateType') aggregateType: string,
    @Param('aggregateId', ParseUUIDPipe) aggregateId: string,
    @Query() query: CheckConcurrencyDto,
  ): Promise<ConcurrencyCheckResult> {
    const validatedTenantId = this.getVerifiedTenantId(request);
    this.validateAggregateType(aggregateType);

    return this.eventStoreService.checkConcurrency(
      validatedTenantId,
      aggregateType,
      aggregateId,
      query.expectedVersion ?? -1,
    );
  }

  /**
   * Delete a stream (soft delete)
   */
  @Delete('streams/:aggregateType/:aggregateId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteStream(
    @Req() request: TenantRequest,
    @Param('aggregateType') aggregateType: string,
    @Param('aggregateId', ParseUUIDPipe) aggregateId: string,
  ): Promise<void> {
    const validatedTenantId = this.getVerifiedTenantId(request);
    this.validateAggregateType(aggregateType);

    await this.eventStoreService.deleteStream(validatedTenantId, aggregateType, aggregateId);
  }

  /**
   * Read all events (global)
   */
  @Get()
  async readAllEvents(
    @Req() request: TenantRequest,
    @Query() query: ReadAllEventsDto,
  ): Promise<AllEventsSlice> {
    const validatedTenantId = this.getVerifiedTenantId(request);

    return this.eventStoreService.readAllEvents(validatedTenantId, {
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
    @Req() request: TenantRequest,
    @Query() query: SearchEventsDto,
  ): Promise<{
    events: PersistedEvent[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const validatedTenantId = this.getVerifiedTenantId(request);

    return this.eventStoreService.searchEvents(
      validatedTenantId,
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
    @Req() request: TenantRequest,
  ): Promise<EventStoreStatsDto> {
    const validatedTenantId = this.getVerifiedTenantId(request);

    const stats = await this.eventStoreService.getStatistics(validatedTenantId);
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
    @Req() request: TenantRequest,
    @Body() dto: CreateSnapshotDto,
  ): Promise<SnapshotData> {
    const validatedTenantId = this.getVerifiedTenantId(request);

    const snapshot = await this.eventStoreService.createSnapshot(
      validatedTenantId,
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
    @Req() request: TenantRequest,
    @Param('aggregateType') aggregateType: string,
    @Param('aggregateId', ParseUUIDPipe) aggregateId: string,
  ): Promise<SnapshotData> {
    const validatedTenantId = this.getVerifiedTenantId(request);
    this.validateAggregateType(aggregateType);

    const snapshot = await this.eventStoreService.getSnapshot(
      validatedTenantId,
      aggregateType,
      aggregateId,
    );

    if (!snapshot) {
      throw new NotFoundException(`Snapshot for ${aggregateType}/${aggregateId} not found`);
    }

    return snapshot;
  }

  /**
   * Load aggregate from snapshot + events
   */
  @Get('aggregates/:aggregateType/:aggregateId')
  async loadAggregate(
    @Req() request: TenantRequest,
    @Param('aggregateType') aggregateType: string,
    @Param('aggregateId', ParseUUIDPipe) aggregateId: string,
  ): Promise<{
    snapshot: SnapshotData | null;
    events: PersistedEvent[];
    currentVersion: number;
  }> {
    const validatedTenantId = this.getVerifiedTenantId(request);
    this.validateAggregateType(aggregateType);

    return this.eventStoreService.loadAggregate(validatedTenantId, aggregateType, aggregateId);
  }

  /**
   * Validate aggregate type against an allowlist pattern to prevent
   * stream name collisions and log injection.
   */
  private validateAggregateType(aggregateType: string): void {
    if (!AGGREGATE_TYPE_PATTERN.test(aggregateType)) {
      throw new BadRequestException(
        `Invalid aggregate type: must match ^[A-Za-z][A-Za-z0-9]{0,63}$`,
      );
    }
  }

  /**
   * Read tenant ID from the service-identity guard result.
   * Raw request headers are intentionally not a controller trust source.
   */
  private getVerifiedTenantId(request: TenantRequest): string {
    const tenantId = request.verifiedIdentity?.effectiveTenantId ?? request.tenantId;
    if (!tenantId || typeof tenantId !== 'string') {
      throw new UnauthorizedException('Verified tenant context is required');
    }

    const trimmed = tenantId.trim();
    if (trimmed.length === 0) {
      throw new UnauthorizedException('Verified tenant context cannot be empty');
    }

    if (!UUID_REGEX.test(trimmed)) {
      throw new UnauthorizedException('Invalid tenant ID format');
    }

    return trimmed;
  }
}
