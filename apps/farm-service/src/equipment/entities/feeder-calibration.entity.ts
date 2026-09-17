/**
 * FeederCalibration — how much feed THIS feeder moves for THIS feed.
 *
 * One row per (feeder, feed). The row carries the physics of exactly one kind of
 * feeder, and which kind is not its own choice: `dosingMode` is FK-pinned to the
 * owning `feeder_capabilities` row, so a grams-per-shot number on a VFD auger —
 * or a grams-per-minute number on a shot feeder — cannot be committed by any
 * writer, including raw SQL.
 *
 * ## Why the key is `feedId` and not pellet diameter
 *
 * This table used to be keyed by `feed_size_mm`. A diameter is not an identity:
 * two 4 mm feeds from different mills differ in bulk density and fat coating and
 * flow through the same auger at measurably different rates, so one 4 mm row
 * silently claimed to calibrate both. Worse, `feedId` is the axis the rest of the
 * feeding system already turns on — `ProtocolBand.feedId` is what a weight band
 * selects. Keying calibration on the same axis is what makes the feed transition
 * automatic: when fish grow into the next band the band's `feedId` changes, and
 * the matching calibration row is found by that id with nobody re-typing
 * anything. Pellet diameter has not been lost, it has been de-duplicated — it
 * lives on `feeds.pelletSize`, one statement per feed, reachable through the FK.
 *
 * ## Why continuous flow is modelled as a rate AT A SPEED
 *
 * A shot feeder's calibration is a scalar: one actuation, one mass. A VFD-driven
 * auger has no such quantum — it is volumetric, displacing a fixed volume per
 * screw revolution, so mass flow is a RATE and that rate rises with drive
 * frequency. A bare "40 g/min" is therefore an incomplete statement: it is only
 * true at the speed it was measured at. `gramsPerMinute` and `referenceSpeedHz`
 * are stored together and are meaningless apart, and the CHECK constraints admit
 * neither without the other.
 *
 * The band copy (`minSpeedHz`/`maxSpeedHz`) is NOT a second statement of the
 * feeder's band — it is the SAME statement, carried under
 * `FK_fcal_feeder_speed_band` so the copy is physically incapable of differing
 * from the capability row's value (`ON UPDATE CASCADE` rewrites it). It is here
 * for one reason: it turns "the measurement must lie inside the drive's usable
 * range" into a plain local CHECK. Narrowing a feeder's band below an existing
 * measurement then fails at the cascade, which is the correct outcome — the
 * measurement it invalidates has to be redone.
 *
 * Per-tenant table (omits `schema:`; search_path routes it into `tenant_<uuid>`).
 *
 * @module Equipment/Entities
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { DecimalTransformer } from '@aquaculture/backend-common/database';

import { FeederDosingMode } from './feeder-capability.entity';

@Entity('feeder_calibrations')
@Index(['tenantId', 'equipmentId', 'feedId'], { unique: true })
export class FeederCalibration {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  /** `equipment.id` of the feeder — same identity `FeederAssignment` binds. */
  @Column({ type: 'uuid', name: 'equipment_id' })
  equipmentId!: string;

  /** `feeds.id` — the identity `ProtocolBand.feedId` selects. FK-bound. */
  @Column({ type: 'uuid', name: 'feed_id' })
  feedId!: string;

  /**
   * FK-pinned copy of the feeder's dosing mode. It is not a choice made here:
   * `FK_fcal_feeder_mode` targets `(tenant_id, equipment_id, dosing_mode)` on
   * `feeder_capabilities`, so the only value that can be written is the one the
   * feeder already has, and flipping a commissioned feeder's mode while
   * calibrations exist is rejected rather than silently invalidating them.
   */
  @Column({ type: 'varchar', length: 20, name: 'dosing_mode' })
  dosingMode!: FeederDosingMode;

  /**
   * DISCRETE feeders: mass thrown by one actuation. NOT NULL exactly when
   * `dosingMode` is DISCRETE.
   */
  @Column({
    type: 'numeric',
    precision: 8,
    scale: 2,
    nullable: true,
    name: 'grams_per_dispensing',
    transformer: new DecimalTransformer(),
  })
  gramsPerDispensing?: number;

  /**
   * CONTINUOUS feeders: measured mass flow, in grams per minute, AT
   * `referenceSpeedHz`. The operator's own unit ("this feed is 10 g/min, that
   * one is 40"). NOT NULL exactly when `dosingMode` is CONTINUOUS.
   */
  @Column({
    type: 'numeric',
    precision: 10,
    scale: 3,
    nullable: true,
    name: 'grams_per_minute',
    transformer: new DecimalTransformer(),
  })
  gramsPerMinute?: number;

  /**
   * The drive frequency the rate above was measured at. Without it the rate says
   * nothing about any other speed. CHECK-constrained to lie inside the feeder's
   * usable band. NOT NULL exactly when `dosingMode` is CONTINUOUS.
   */
  @Column({
    type: 'numeric',
    precision: 6,
    scale: 2,
    nullable: true,
    name: 'reference_speed_hz',
    transformer: new DecimalTransformer(),
  })
  referenceSpeedHz?: number;

  /** FK-carried copy of `feeder_capabilities.min_speed_hz` — see class doc. */
  @Column({
    type: 'numeric',
    precision: 6,
    scale: 2,
    nullable: true,
    name: 'min_speed_hz',
    transformer: new DecimalTransformer(),
  })
  minSpeedHz?: number;

  /** FK-carried copy of `feeder_capabilities.max_speed_hz` — see class doc. */
  @Column({
    type: 'numeric',
    precision: 6,
    scale: 2,
    nullable: true,
    name: 'max_speed_hz',
    transformer: new DecimalTransformer(),
  })
  maxSpeedHz?: number;

  @Column({ type: 'text', nullable: true, name: 'notes' })
  notes?: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
