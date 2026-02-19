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
  registerDecorator,
  ValidationOptions,
  ValidationArguments,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';

/**
 * Maximum number of days in the past an occurredAt timestamp may be.
 * Events older than this window are rejected to prevent audit-trail backdating.
 */
const OCCURRED_AT_MAX_PAST_DAYS = 30;

/**
 * Maximum number of minutes in the future an occurredAt timestamp may be.
 * A small tolerance accommodates legitimate clock skew between services.
 */
const OCCURRED_AT_MAX_FUTURE_MINUTES = 5;

/**
 * Custom validator that rejects occurredAt timestamps outside a safe window:
 *   - No more than OCCURRED_AT_MAX_PAST_DAYS days in the past.
 *   - No more than OCCURRED_AT_MAX_FUTURE_MINUTES minutes in the future.
 */
function IsOccurredAtWithinBounds(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isOccurredAtWithinBounds',
      target: (object as { constructor: Function }).constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown, _args: ValidationArguments): boolean {
          if (value === undefined || value === null) {
            return true; // @IsOptional handles absence
          }
          const ts = new Date(value as string);
          if (isNaN(ts.getTime())) {
            return false; // @IsDateString handles format; this is a safety net
          }
          const now = Date.now();
          const pastLimit = now - OCCURRED_AT_MAX_PAST_DAYS * 24 * 60 * 60 * 1000;
          const futureLimit = now + OCCURRED_AT_MAX_FUTURE_MINUTES * 60 * 1000;
          return ts.getTime() >= pastLimit && ts.getTime() <= futureLimit;
        },
        defaultMessage(_args: ValidationArguments): string {
          return (
            `occurredAt must be within the last ${OCCURRED_AT_MAX_PAST_DAYS} days ` +
            `and no more than ${OCCURRED_AT_MAX_FUTURE_MINUTES} minutes in the future`
          );
        },
      },
    });
  };
}

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
  @IsOccurredAtWithinBounds()
  occurredAt?: string;

  @IsOptional()
  @IsNumber()
  @Min(1)
  schemaVersion?: number;
}

/**
 * DTO for appending multiple events to a stream.
 * Note: aggregateType and aggregateId are provided via URL path parameters
 * and are intentionally optional here — any body values are ignored by the
 * controller, which uses the URL params exclusively.
 */
export class AppendEventsDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  aggregateType?: string;

  @IsOptional()
  @IsUUID()
  aggregateId?: string;

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
