import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';
import { ObjectType, Field, ID, Float, Int } from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-scalars';
import { DecimalTransformer } from '@aquaculture/backend-common/database';

/**
 * A single reference point captured during a calibration procedure: the raw
 * reading the sensor produced and the known reference value it should have
 * produced. Kept for provenance so a later audit can re-derive the coefficients.
 */
export interface CalibrationReferencePoint {
  raw: number;
  reference: number;
  label?: string;
}

/**
 * CalibrationEvent — immutable record of one calibration performed on a data
 * channel (SENSOR-HIGH-083).
 *
 * Before this aggregate existed, `updateDataChannel` was the only write path for
 * calibration coefficients and it NEVER stamped `lastCalibratedAt`, so every
 * channel reported "never calibrated" forever and overdue-calibration warnings
 * (a compliance-relevant signal in aquaculture water quality) could never fire.
 * This table makes the calibration event the single source of truth for a
 * channel's calibration history: each `recordCalibration` appends one row here
 * AND atomically stamps the channel's coefficients + `lastCalibratedAt` +
 * `nextCalibrationDue`, so the status the UI derives is finally truthful.
 *
 * Per-tenant table (ADR-011): `@Entity()` OMITS `schema:` so search_path routes
 * it into `tenant_<uuid>` at runtime, exactly like `sensor_data_channels` and
 * `sensors` which it references. It is NOT a cross-tenant audit ledger — a
 * calibration is per-tenant operational history, cloned into each tenant schema
 * (registered in `MODULE_SCHEMAS['sensor'].tables`). Append-only: no
 * `UpdateDateColumn` — a calibration event is never modified after it is written.
 */
@ObjectType({ description: 'Immutable record of one channel calibration' })
@Entity('calibration_events')
@Index(['tenantId', 'channelId', 'calibratedAt'])
@Index(['tenantId', 'sensorId'])
export class CalibrationEvent {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Field()
  @Column({ type: 'uuid', name: 'channel_id' })
  channelId!: string;

  @Field()
  @Column({ type: 'uuid', name: 'sensor_id' })
  sensorId!: string;

  // === Resulting linear coefficients (value = raw * multiplier + offset) ===

  @Field(() => Float)
  // DecimalTransformer: numeric columns come back as strings otherwise, and the
  // multiplier is multiplied into every reading — string arithmetic yields NaN.
  @Column({
    name: 'calibration_multiplier',
    type: 'numeric',
    precision: 15,
    scale: 6,
    transformer: new DecimalTransformer(),
  })
  calibrationMultiplier!: number;

  @Field(() => Float)
  @Column({
    name: 'calibration_offset',
    type: 'numeric',
    precision: 15,
    scale: 6,
    transformer: new DecimalTransformer(),
  })
  calibrationOffset!: number;

  // === Provenance: the reference points the coefficients were derived from ===

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ name: 'reference_values', type: 'jsonb', nullable: true })
  referenceValues?: CalibrationReferencePoint[];

  // === Scheduling: interval applied and the resulting due date ===

  @Field(() => Int, { nullable: true })
  @Column({ name: 'interval_days', type: 'int', nullable: true })
  intervalDays?: number;

  @Field({ nullable: true })
  @Column({ name: 'next_calibration_due', type: 'timestamptz', nullable: true })
  nextCalibrationDue?: Date;

  // === Actor + notes ===

  /** Actor identity (user id / subject) that performed the calibration. */
  @Field()
  @Column({ type: 'varchar', length: 255, name: 'performed_by' })
  performedBy!: string;

  @Field({ nullable: true })
  @Column({ type: 'varchar', length: 255, name: 'performed_by_email', nullable: true })
  performedByEmail?: string;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  notes?: string;

  @Field()
  @CreateDateColumn({ name: 'calibrated_at', type: 'timestamptz' })
  calibratedAt!: Date;
}
