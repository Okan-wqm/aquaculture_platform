import {
  IsString,
  IsOptional,
  IsUUID,
  IsNotEmpty,
  MaxLength,
  IsObject,
  IsNumber,
  Min,
  Max,
  IsEnum,
  IsDateString,
  IsArray,
  ValidateNested,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';

/**
 * DTO for appending a single event to a stream
 */
export class AppendEventDto {
  @IsString()
  @MaxLength(255)
  @IsNotEmpty()
  eventType!: string;

  @IsObject()
  @IsNotEmpty()
  payload!: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;

  @IsOptional()
  @IsUUID()
  correlationId?: string;

  @IsOptional()
  @IsUUID()
  causationId?: string;

  @IsOptional()
  @IsUUID()
  userId?: string;

  @IsOptional()
  @IsDateString()
  occurredAt?: string;

  @IsOptional()
  @IsNumber()
  @Min(1)
  schemaVersion?: number;
}

/**
 * DTO for appending multiple events to a stream
 */
export class AppendEventsDto {
  @IsString()
  @MaxLength(255)
  @IsNotEmpty()
  aggregateType!: string;

  @IsUUID()
  @IsNotEmpty()
  aggregateId!: string;

  @IsNumber()
  @Min(-1)
  expectedVersion!: number; // -1 for any, 0 for new stream

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AppendEventDto)
  events!: AppendEventDto[];
}

/**
 * Query parameters for reading events from a stream
 */
export class ReadStreamDto {
  @IsOptional()
  @Transform(({ value }) => parseInt(value, 10))
  @IsNumber()
  @Min(0)
  fromVersion?: number = 0;

  @IsOptional()
  @Transform(({ value }) => parseInt(value, 10))
  @IsNumber()
  @Min(1)
  @Max(1000)
  maxCount?: number = 100;

  @IsOptional()
  @IsEnum(['forward', 'backward'])
  direction?: 'forward' | 'backward' = 'forward';
}

/**
 * Query parameters for reading all events
 */
export class ReadAllEventsDto {
  @IsOptional()
  @Transform(({ value }) => parseInt(value, 10))
  @IsNumber()
  @Min(0)
  fromPosition?: number = 0;

  @IsOptional()
  @Transform(({ value }) => parseInt(value, 10))
  @IsNumber()
  @Min(1)
  @Max(1000)
  maxCount?: number = 100;

  @IsOptional()
  @IsEnum(['forward', 'backward'])
  direction?: 'forward' | 'backward' = 'forward';

  @IsOptional()
  @IsString()
  @MaxLength(255)
  eventType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  aggregateType?: string;

  @IsOptional()
  @IsDateString()
  fromDate?: string;

  @IsOptional()
  @IsDateString()
  toDate?: string;
}

/**
 * Query parameters for searching events
 */
export class SearchEventsDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  eventType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  aggregateType?: string;

  @IsOptional()
  @IsUUID()
  aggregateId?: string;

  @IsOptional()
  @IsUUID()
  correlationId?: string;

  @IsOptional()
  @IsUUID()
  userId?: string;

  @IsOptional()
  @IsDateString()
  fromDate?: string;

  @IsOptional()
  @IsDateString()
  toDate?: string;

  @IsOptional()
  @Transform(({ value }) => parseInt(value, 10))
  @IsNumber()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Transform(({ value }) => parseInt(value, 10))
  @IsNumber()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @IsOptional()
  @IsEnum(['occurredAt', 'storedAt', 'globalPosition'])
  sortBy?: 'occurredAt' | 'storedAt' | 'globalPosition' = 'globalPosition';

  @IsOptional()
  @IsEnum(['ASC', 'DESC'])
  sortOrder?: 'ASC' | 'DESC' = 'ASC';
}

/**
 * DTO for creating a snapshot
 */
export class CreateSnapshotDto {
  @IsString()
  @MaxLength(255)
  @IsNotEmpty()
  aggregateType!: string;

  @IsUUID()
  @IsNotEmpty()
  aggregateId!: string;

  @IsNumber()
  @Min(1)
  version!: number;

  @IsObject()
  @IsNotEmpty()
  state!: Record<string, unknown>;

  @IsOptional()
  @IsNumber()
  @Min(1)
  schemaVersion?: number;
}

/**
 * DTO for stream subscription
 */
export class SubscribeDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  streamName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  eventType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  aggregateType?: string;

  @IsOptional()
  @Transform(({ value }) => parseInt(value, 10))
  @IsNumber()
  @Min(0)
  fromPosition?: number;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  consumerGroup?: string;
}

/**
 * Response DTO for stream information
 */
export class StreamInfoDto {
  streamName!: string;
  aggregateType!: string;
  aggregateId!: string;
  currentVersion!: number;
  eventCount!: number;
  createdAt!: Date;
  lastEventAt?: Date;
  hasSnapshot!: boolean;
  snapshotVersion?: number;
}

/**
 * Response DTO for event store statistics
 */
export class EventStoreStatsDto {
  totalEvents!: number;
  totalStreams!: number;
  totalSnapshots!: number;
  eventsLast24h!: number;
  eventsByType!: Record<string, number>;
  eventsByAggregate!: Record<string, number>;
  storageUsedMb!: number;
}
