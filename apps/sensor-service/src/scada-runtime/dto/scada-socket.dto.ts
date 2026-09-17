/**
 * SCADA Socket DTOs
 *
 * NestJS-compatible DTOs mirroring the shared SCADA socket contracts.
 * These are the inbound payload classes validated at the WebSocket gateway
 * boundary. All fields use class-validator decorators so ValidationPipe
 * can reject malformed messages before they reach business logic.
 *
 * Shared types live in:
 *   web/modules/sensor-module/src/types/scada-runtime.types.ts
 */

import {
  IsString,
  IsArray,
  IsNumber,
  IsOptional,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  Min,
  MinLength,
  ArrayMinSize,
  ArrayMaxSize,
  ValidateNested,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';

// TODO: Replace with '@aquaculture/scada-types' path alias when monorepo build supports it.
import type {
  TagWritePayload,
  DaqQueryPayload,
  DaqAggregation,
} from '../scada-types';

/* ------------------------------------------------------------------ */
/*  Constants                                                           */
/* ------------------------------------------------------------------ */

/** Maximum number of tag IDs a client may subscribe/unsubscribe in one call. */
export const MAX_TAG_IDS_PER_SUBSCRIPTION = 500;

/** Allowed write function values. */
export const ALLOWED_WRITE_FUNCTIONS = ['set', 'add', 'remove'] as const;

/** Allowed DAQ aggregation functions. */
export const ALLOWED_DAQ_AGGREGATION_FUNCTIONS = ['min', 'max', 'avg', 'sum'] as const;

/** Allowed DAQ aggregation intervals. */
export const ALLOWED_DAQ_AGGREGATION_INTERVALS = [
  '1min', '5min', '10min', '30min', '1h', '1d',
] as const;

/* ------------------------------------------------------------------ */
/*  DAQ query safety limits (M7)                                       */
/* ------------------------------------------------------------------ */

/** Raw (unaggregated) queries may span at most 7 days. */
export const DAQ_RAW_MAX_SPAN_MS = 7 * 24 * 60 * 60 * 1000;

/** Aggregated queries may span at most 365 days. */
export const DAQ_AGG_MAX_SPAN_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Hard cap on the total data points a single query may request
 * (`tagIds × buckets`) — reject with guidance to aggregate instead.
 */
export const DAQ_MAX_TOTAL_POINTS = 200_000;

/**
 * Conservative planning estimate of the raw ingest cadence (one sample per
 * tag per 10 s) used ONLY to bound a raw query's worst-case point count
 * before it hits the database; the storage layer's SQL LIMIT stays the hard
 * bound on what is actually read.
 */
export const DAQ_RAW_ASSUMED_SAMPLE_INTERVAL_MS = 10_000;

/** Aggregation interval → bucket width in ms. */
export const DAQ_INTERVAL_MS: Record<DaqAggregation['interval'], number> = {
  '1min': 60_000,
  '5min': 5 * 60_000,
  '10min': 10 * 60_000,
  '30min': 30 * 60_000,
  '1h': 60 * 60_000,
  '1d': 24 * 60 * 60_000,
};

/** Per-socket DAQ_QUERY token bucket: sustained rate. */
export const DAQ_RATE_REFILL_PER_SEC = 5;

/** Per-socket DAQ_QUERY token bucket: burst capacity. */
export const DAQ_RATE_BURST = 10;

/* ------------------------------------------------------------------ */
/*  TAG_SUBSCRIBE / TAG_UNSUBSCRIBE                                     */
/* ------------------------------------------------------------------ */

/**
 * Payload for ScadaSocketEvent.TAG_SUBSCRIBE and TAG_UNSUBSCRIBE.
 *
 * Example:
 *   { tagIds: ['tank1.do', 'tank1.temp'] }
 */
export class TagSubscriptionDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_TAG_IDS_PER_SUBSCRIPTION)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  tagIds!: string[];
}

/* ------------------------------------------------------------------ */
/*  TAG_WRITE                                                           */
/* ------------------------------------------------------------------ */

/**
 * Payload for ScadaSocketEvent.TAG_WRITE.
 *
 * Example:
 *   { tagId: 'tank1.setpoint', value: 7.5, function: 'set' }
 */
export class TagWriteDto implements TagWritePayload {
  @IsString()
  @IsNotEmpty()
  tagId!: string;

  // value is deliberately typed as `unknown` in the shared contract — no
  // class-validator constraint applied here; callers must validate at the
  // device-driver layer.
  value!: unknown;

  @IsOptional()
  @IsIn(ALLOWED_WRITE_FUNCTIONS)
  function?: 'set' | 'add' | 'remove';
}

/* ------------------------------------------------------------------ */
/*  DAQ_QUERY                                                           */
/* ------------------------------------------------------------------ */

/**
 * Nested aggregation object within DaqQueryDto.
 */
export class DaqAggregationDto implements DaqAggregation {
  @IsIn(ALLOWED_DAQ_AGGREGATION_FUNCTIONS)
  function!: 'min' | 'max' | 'avg' | 'sum';

  @IsIn(ALLOWED_DAQ_AGGREGATION_INTERVALS)
  interval!: '1min' | '5min' | '10min' | '30min' | '1h' | '1d';
}

/**
 * Payload for ScadaSocketEvent.DAQ_QUERY.
 *
 * Example:
 *   {
 *     queryId: 'q-001',
 *     tagIds: ['tank1.do'],
 *     from: 1710000000000,
 *     to:   1710003600000,
 *     chunked: true,
 *   }
 */
export class DaqQueryDto implements DaqQueryPayload {
  @IsString()
  @IsNotEmpty()
  queryId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_TAG_IDS_PER_SUBSCRIPTION)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  tagIds!: string[];

  @IsNumber()
  @Min(0)
  from!: number;

  @IsNumber()
  @Min(0)
  to!: number;

  @IsOptional()
  @IsBoolean()
  chunked?: boolean;

  @IsOptional()
  @ValidateNested()
  @Type(() => DaqAggregationDto)
  aggregation?: DaqAggregationDto;
}

/* ------------------------------------------------------------------ */
/*  PIN_VERIFY (SENSOR-CRITICAL-006)                                    */
/* ------------------------------------------------------------------ */

/**
 * Verify a control-security PIN server-side. The stored PIN never leaves the
 * server; the socket gains a bounded elevation window on success.
 */
export class PinVerifyDto {
  @IsUUID()
  packageId!: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(6)
  @MaxLength(32)
  pin!: string;
}

/* ------------------------------------------------------------------ */
/*  ALARM_ACK                                                           */
/* ------------------------------------------------------------------ */

/**
 * Payload for ScadaSocketEvent.ALARM_ACK.
 *
 * Example:
 *   { alarmInstanceId: 'ai-001', comment: 'Checked and resolved.' }
 */
export class AlarmAckDto {
  @IsString()
  @IsNotEmpty()
  alarmInstanceId!: string;

  @IsOptional()
  @IsString()
  comment?: string;
}

/**
 * Payload for ScadaSocketEvent.ALARM_ACK_ALL.
 *
 * Example:
 *   { group: 'tank-1', comment: 'Shift handover acknowledged.' }
 */
export class AlarmAckAllDto {
  @IsOptional()
  @IsString()
  group?: string;

  @IsOptional()
  @IsString()
  comment?: string;
}

/* ------------------------------------------------------------------ */
/*  Error envelope (server → client)                                   */
/* ------------------------------------------------------------------ */

/**
 * Standardised error payload emitted back to the originating socket.
 */
export interface ScadaErrorPayload {
  /** The socket event name that triggered the error. */
  event: string;
  /** Machine-readable error code (e.g. 'VALIDATION_ERROR', 'AUTH_REQUIRED'). */
  code: string;
  /** Human-readable message. */
  message: string;
  /** Wall-clock timestamp (unix ms). */
  timestamp: number;
}

/** Well-known error codes emitted by the SCADA gateway. */
export const SCADA_ERROR_CODES = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  FORBIDDEN: 'FORBIDDEN',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  NOT_SUBSCRIBED: 'NOT_SUBSCRIBED',
  /** Additive (M7): per-socket token-bucket exhaustion on DAQ_QUERY. */
  RATE_LIMITED: 'RATE_LIMITED',
} as const;

export type ScadaErrorCode = (typeof SCADA_ERROR_CODES)[keyof typeof SCADA_ERROR_CODES];
