import { ObjectType, Field, ID, Float, Int, registerEnumType } from '@nestjs/graphql';
import { Entity, Column, Index, PrimaryColumn, ManyToOne, JoinColumn } from 'typeorm';

import { SensorDataChannel } from './sensor-data-channel.entity';
import { Sensor } from './sensor.entity';

/**
 * Quality code categories aligned with OPC-UA standard
 * Good: 192-255 (normal operation)
 * Uncertain: 64-127 (questionable data)
 * Bad: 0-63 (unusable data)
 */
export enum QualityCategory {
  GOOD = 'good',
  UNCERTAIN = 'uncertain',
  BAD = 'bad',
}

registerEnumType(QualityCategory, {
  name: 'QualityCategory',
  description: 'OPC-UA aligned quality category',
});

/** First code in the OPC-UA DA "uncertain" band. */
export const QUALITY_UNCERTAIN_MIN = 64;

/**
 * First code in the OPC-UA DA "good" band. This is `quality_code`'s column
 * default and the threshold every SQL consumer spells as
 * `quality_code >= 192`.
 */
export const QUALITY_GOOD_MIN = 192;

/**
 * Band a raw `quality_code` falls in.
 *
 * The band boundaries used to be inline literals in the entity's
 * `qualityCategory` getter, which only helps code holding a hydrated
 * SensorMetric. The as-of read projection works on raw rows, so it needed
 * the same classification without an entity — and a second copy of `>= 192`
 * is exactly how two parts of one system start disagreeing about what
 * "good" means. One function, both callers.
 */
export function qualityCategoryOf(code: number): QualityCategory {
  if (code >= QUALITY_GOOD_MIN) return QualityCategory.GOOD;
  if (code >= QUALITY_UNCERTAIN_MIN) return QualityCategory.UNCERTAIN;
  return QualityCategory.BAD;
}

/**
 * Common quality codes (OPC-UA aligned)
 */
export const QualityCodes = {
  // Good (192-255)
  GOOD: 192,
  GOOD_LOCAL_OVERRIDE: 193,

  // Uncertain (64-127)
  UNCERTAIN: 64,
  UNCERTAIN_LAST_USABLE: 65,
  UNCERTAIN_SENSOR_NOT_ACCURATE: 66,
  UNCERTAIN_EU_EXCEEDED: 67,
  UNCERTAIN_SUBNORMAL: 68,

  // Bad (0-63)
  BAD: 0,
  BAD_CONFIG_ERROR: 1,
  BAD_NOT_CONNECTED: 2,
  BAD_DEVICE_FAILURE: 3,
  BAD_SENSOR_FAILURE: 4,
  BAD_COMM_FAILURE: 5,
  BAD_OUT_OF_SERVICE: 6,
  BAD_WAITING_INITIAL: 7,
} as const;

/**
 * SensorMetric Entity
 *
 * NOTE: This entity is NOT registered in any module's forFeature() or the app.module entities list.
 * It is intentionally used only as a TypeScript type interface and for constants (QualityCodes).
 * The actual sensor_metrics table is created and managed via migrations (CreateSensorMetrics),
 * not TypeORM synchronize, because it is a TimescaleDB hypertable.
 *
 * Core time-series data storage optimized for TimescaleDB hypertable.
 * Uses narrow table design (EAV-like) for maximum flexibility and performance.
 *
 * Key features:
 * - Each measurement is a separate row (channel_id identifies the metric type)
 * - Supports 50K+ writes/second with batch inserts
 * - Automatic compression after 7 days (10-20x reduction)
 * - Continuous aggregates for fast historical queries
 * - OPC-UA aligned quality codes
 *
 * SENSOR-HIGH-085: this is a PER-TENANT hypertable — every tenant's telemetry
 * lives in that tenant's own `tenant_<uuid>` schema, so the entity OMITS
 * `schema:` and the search_path routes it. It is delivered by migration
 * 1815000000000, which creates it unqualified so provisioning's migration replay
 * lands one in every tenant schema.
 *
 * The obstacle this design had to solve is that three of the four ingestion
 * paths are process-wide singletons with no per-request search_path. Pinning the
 * table to a shared schema "solved" that by giving up tenant isolation; the
 * structural fix is that SensorMetricWriterService derives the destination
 * schema from each row's own tenantId, so a singleton writes to the right tenant
 * schema without needing an ambient one.
 */
@ObjectType()
@Entity('sensor_metrics')
@Index(['sensorId', 'time'])
@Index(['channelId', 'time'])
@Index(['tenantId', 'time'])
@Index(['tankId', 'time'])
@Index(['equipmentId', 'time'])
// SENSOR-HIGH-085: (sensor_id, channel_id, time DESC) — created in DB by
// migration 1815000000000 alongside the per-tenant hypertable itself; leads with
// (sensor_id, channel_id) so the as-of reading projection's per-channel "latest
// where time <= T" lookups are index seeks. Declared here for entity↔table
// parity (the store's DDL is migration-owned).
@Index(['sensorId', 'channelId', 'time'])
export class SensorMetric {
  /**
   * Composite primary key: time + sensor_id + channel_id
   * This allows TimescaleDB to efficiently partition by time
   */
  @Field()
  @PrimaryColumn({ type: 'timestamptz', name: 'time' })
  time!: Date;

  @Field(() => ID)
  @PrimaryColumn('uuid', { name: 'sensor_id' })
  sensorId!: string;

  @Field(() => ID)
  @PrimaryColumn('uuid', { name: 'channel_id' })
  channelId!: string;

  // === Tenant Identification ===

  @Field(() => ID)
  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  // === Location Context (Denormalized for Query Performance) ===

  @Field(() => ID, { nullable: true })
  @Column('uuid', { name: 'site_id', nullable: true })
  siteId?: string;

  @Field(() => ID, { nullable: true })
  @Column('uuid', { name: 'department_id', nullable: true })
  departmentId?: string;

  @Field(() => ID, { nullable: true })
  @Column('uuid', { name: 'system_id', nullable: true })
  systemId?: string;

  @Field(() => ID, { nullable: true })
  @Column('uuid', { name: 'equipment_id', nullable: true })
  equipmentId?: string;

  @Field(() => ID, { nullable: true })
  @Column('uuid', { name: 'tank_id', nullable: true })
  tankId?: string;

  @Field(() => ID, { nullable: true })
  @Column('uuid', { name: 'pond_id', nullable: true })
  pondId?: string;

  @Field(() => ID, { nullable: true })
  @Column('uuid', { name: 'farm_id', nullable: true })
  farmId?: string;

  // === Measurement Values ===

  // WHY: rawValue and value use `double precision` (float8) instead of `numeric`
  // for TimescaleDB hypertable performance. Rationale:
  //
  // 1. WRITE THROUGHPUT: float8 arithmetic is hardware-accelerated (FPU).
  //    numeric uses software arbitrary-precision math -- 3-5x slower per row.
  //    At 50K+ writes/second, this difference is material for ingestion SLA.
  //
  // 2. STORAGE: float8 is 8 bytes fixed. numeric(10,4) is 8-14 bytes variable.
  //    For hypertables with billions of rows, the storage overhead compounds
  //    in both raw storage and compression ratio.
  //
  // 3. CONTINUOUS AGGREGATES: TimescaleDB continuous aggregates (avg, min, max)
  //    on float8 columns use hardware SIMD instructions and are significantly
  //    faster than numeric aggregates.
  //
  // TRADEOFF: float8 has ~15-17 significant digits of precision. For sensor
  // measurements (pH, temperature, dissolved oxygen) this is more than adequate.
  // However, for COMPLIANCE THRESHOLD COMPARISONS (e.g., pH 6.9999999 vs 7.0),
  // exact comparison on float8 can produce false positives/negatives.
  //
  // RESOLUTION (DB-CRITICAL-002): Compliance reporting queries and continuous
  // aggregates used for threshold comparison MUST cast to NUMERIC at query time:
  //   WHERE value::numeric(10,4) > threshold::numeric(10,4)
  // This keeps write-path fast while ensuring compliance-path correctness.
  // The continuous aggregates for compliance reporting are defined in
  // init-sensor-schema.sql with explicit NUMERIC casts.
  //
  // @see DB-CRITICAL-002 (float vs numeric tradeoff)

  /**
   * Raw value before calibration.
   * Uses double precision for hypertable write performance.
   * @see DB-CRITICAL-002 for compliance threshold comparison guidance
   */
  @Field(() => Float)
  @Column('double precision', { name: 'raw_value' })
  rawValue!: number;

  /**
   * Calibrated/processed value.
   * value = raw_value * calibration_multiplier + calibration_offset
   * Uses double precision for hypertable write performance.
   * @see DB-CRITICAL-002 for compliance threshold comparison guidance
   */
  @Field(() => Float)
  @Column('double precision', { name: 'value' })
  value!: number;

  // === Data Quality (OPC-UA Aligned) ===

  /**
   * Quality code following OPC-UA standard:
   * - 192-255: Good
   * - 64-127: Uncertain
   * - 0-63: Bad
   */
  @Field(() => Int)
  @Column('smallint', { name: 'quality_code', default: 192 })
  qualityCode!: number;

  /**
   * Quality bits for detailed status (bitmask):
   * Bit 0: Interpolated
   * Bit 1: Extrapolated
   * Bit 2: Manually entered
   * Bit 3: Calibration in progress
   * Bit 4: Rate of change exceeded
   * Bit 5: Out of range (clamped)
   */
  @Field(() => Int)
  @Column('smallint', { name: 'quality_bits', default: 0 })
  qualityBits!: number;

  // === Protocol Metadata ===

  /**
   * Source protocol: mqtt, modbus, opcua, http, manual
   */
  @Field({ nullable: true })
  @Column({ name: 'source_protocol', length: 20, nullable: true })
  sourceProtocol?: string;

  /** Stable producer-generated identity; MQTT packet IDs are session-local. */
  @Field({ nullable: true })
  @Column({ name: 'source_event_id', length: 160, nullable: true })
  sourceEventId?: string;

  /**
   * Original timestamp from the device (may differ from server time)
   */
  @Field({ nullable: true })
  @Column({ type: 'timestamptz', name: 'source_timestamp', nullable: true })
  sourceTimestamp?: Date;

  /** Optional monotonic producer sequence, represented as a bigint-safe string. */
  @Field({ nullable: true })
  @Column({ type: 'bigint', name: 'source_sequence', nullable: true })
  sourceSequence?: string;

  /**
   * Latency between device timestamp and server ingestion (milliseconds)
   */
  @Field(() => Int, { nullable: true })
  @Column('int', { name: 'ingestion_latency_ms', nullable: true })
  ingestionLatencyMs?: number;

  // === Batch Processing ===

  /**
   * Batch ID for bulk imports/backfills
   */
  @Field(() => ID, { nullable: true })
  @Column('uuid', { name: 'batch_id', nullable: true })
  batchId?: string;

  // === Relations (Optional - for joined queries) ===

  @ManyToOne(() => Sensor, { lazy: true })
  @JoinColumn({ name: 'sensor_id' })
  sensor?: Sensor;

  @ManyToOne(() => SensorDataChannel, { lazy: true })
  @JoinColumn({ name: 'channel_id' })
  channel?: SensorDataChannel;

  // === Computed Properties ===

  /**
   * Get quality category from quality code
   */
  get qualityCategory(): QualityCategory {
    return qualityCategoryOf(this.qualityCode);
  }

  /**
   * Check if quality is good
   */
  get isGoodQuality(): boolean {
    return qualityCategoryOf(this.qualityCode) === QualityCategory.GOOD;
  }

  /**
   * Check if data is interpolated
   */
  get isInterpolated(): boolean {
    return (this.qualityBits & 0x01) !== 0;
  }

  /**
   * Check if data was manually entered
   */
  get isManualEntry(): boolean {
    return (this.qualityBits & 0x04) !== 0;
  }

  /**
   * Check if value was clamped (out of range)
   */
  get isClamped(): boolean {
    return (this.qualityBits & 0x20) !== 0;
  }
}

/**
 * Input type for batch metric ingestion
 */
export interface SensorMetricInput {
  time: Date;
  sensorId: string;
  channelId: string;
  tenantId: string;
  rawValue: number;
  value: number;
  qualityCode?: number;
  qualityBits?: number;
  sourceProtocol?: string;
  sourceEventId?: string;
  sourceTimestamp?: Date;
  sourceSequence?: string;
  siteId?: string;
  departmentId?: string;
  systemId?: string;
  equipmentId?: string;
  tankId?: string;
  pondId?: string;
  farmId?: string;
  batchId?: string;
}

/**
 * Aggregated metric data (from continuous aggregates)
 */
@ObjectType()
export class AggregatedMetric {
  @Field()
  bucket!: Date;

  @Field(() => ID)
  sensorId!: string;

  @Field(() => ID)
  channelId!: string;

  @Field(() => Float)
  avgValue!: number;

  @Field(() => Float)
  minValue!: number;

  @Field(() => Float)
  maxValue!: number;

  @Field(() => Float, { nullable: true })
  stddevValue?: number;

  @Field(() => Float, { nullable: true })
  firstValue?: number;

  @Field(() => Float, { nullable: true })
  lastValue?: number;

  @Field(() => Int)
  sampleCount!: number;

  @Field(() => Int, { nullable: true })
  goodCount?: number;

  @Field(() => Float, { nullable: true })
  qualityPct?: number;
}
