/**
 * FeederCapability — what a feeder IS, stated exactly once per feeder.
 *
 * WHAT: one row per FEEDING-category `equipment` row, carrying the three facts
 * that belong to the MACHINE rather than to any feed it happens to dose:
 *
 *   1. `dosingMode` — is this a shot-type feeder (a dosing wheel that throws a
 *      fixed mass per actuation) or a continuous one (a VFD-driven auger whose
 *      mass flow is a rate, not a quantity)? A feeder is one or the other; the
 *      calibration rows for that feeder are FK-pinned to this value, so a row
 *      carrying the WRONG kind of physics for its feeder cannot be stored.
 *   2. `siloCapacityKg` — the hopper's capacity.
 *   3. `dispenseControl` + `weightSensorId` — does this feeder close the loop on
 *      a measured mass (a silo on load cells) or on elapsed time?
 *
 * WHY it is a separate table rather than columns on `equipment`: `equipment` is
 * the generic asset row shared by pumps, blowers, nets and tanks. Feeding-only
 * physics on it would be null for every non-feeder and would have to be guarded
 * by convention at every write. A separate row exists only for feeders, and
 * `feeder_calibrations` FOREIGN-KEYs into it — so a calibration for a machine
 * nobody ever commissioned as a feeder is unstorable rather than merely unusual.
 *
 * WHY `siloCapacityKg` lives HERE and not on the calibration row (the defect this
 * table fixes): calibration rows are per FEED. A silo capacity written on them is
 * restated once per calibrated feed and the copies can disagree — one row says
 * the silo holds 500 kg, the next says 400. A silo has one capacity. Moving it
 * here is not tidying: it removes the second place the value could be written, so
 * the two values can no longer exist to disagree.
 *
 * WHY the speed band lives here too: `minSpeedHz`/`maxSpeedHz` describe the
 * drive and the auger — the range over which mass flow actually tracks drive
 * frequency. That is a property of the machine, so restating it per feed would
 * reintroduce exactly the defect above. Calibration rows carry an FK-pinned COPY
 * (see `FeederCalibration`) purely so the "reference speed is inside the band"
 * rule can be a local CHECK; the FK makes the copy unable to diverge.
 *
 * Per-tenant table (omits `schema:`; search_path routes it into `tenant_<uuid>`).
 *
 * @module Equipment/Entities
 */
import { Entity, Column, PrimaryColumn, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';
import { registerEnumType } from '@nestjs/graphql';
import { DecimalTransformer } from '@aquaculture/backend-common/database';

/**
 * How a feeder converts a demand in grams into an actuation.
 *
 * These are not two settings of one machine — they are two machines. A shot
 * feeder cannot be asked to run for 90 seconds and a continuous auger cannot be
 * asked for 7 shots, so the two calibrations answer different questions and a
 * row that mixes them is meaningless.
 */
export enum FeederDosingMode {
  /**
   * Shot-type: each actuation throws a fixed mass. Calibration is
   * grams-per-dispensing; the derived command is a COUNT.
   */
  DISCRETE = 'discrete',
  /**
   * VFD-driven auger: mass flows continuously while the motor turns.
   * Calibration is grams-per-minute measured at a stated drive speed; the
   * derived command is a SPEED and a DURATION.
   */
  CONTINUOUS = 'continuous',
}

registerEnumType(FeederDosingMode, {
  name: 'FeederDosingMode',
  description: 'Yemleyicinin dozlama fiziği — atımlı (discrete) veya sürekli akış (continuous)',
});

/**
 * What tells the feeder it has delivered the dose.
 *
 * Some farms have load cells under the silo and dispense against a measured mass
 * drop; others have none and dispense against elapsed time. Declaring
 * `WEIGHT_BASED` without a bound weight source would mean waiting for a
 * measurement that never arrives — the feeder would either run forever or stop
 * on nothing — so the database refuses that combination outright
 * (`CK_fcap_weight_source_required`).
 */
export enum FeederDispenseControl {
  /** Delivery is judged by run time / shot count against the calibration. */
  TIME_BASED = 'time_based',
  /** Delivery is judged by the mass the silo actually lost. Requires a source. */
  WEIGHT_BASED = 'weight_based',
}

registerEnumType(FeederDispenseControl, {
  name: 'FeederDispenseControl',
  description: 'Dozun tamamlandığını ne söyler — ölçülen ağırlık mı, geçen süre mi',
});

@Entity('feeder_capabilities')
@Index(['tenantId'])
export class FeederCapability {
  @PrimaryColumn({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  /** `equipment.id` of the feeder. FK-bound in the migration. */
  @PrimaryColumn({ type: 'uuid', name: 'equipment_id' })
  equipmentId!: string;

  @Column({ type: 'varchar', length: 20, name: 'dosing_mode' })
  dosingMode!: FeederDosingMode;

  /**
   * Hopper capacity. Nullable because "not stated yet" is a real commissioning
   * state and is honestly different from zero; the CHECK forbids a stated zero.
   */
  @Column({
    type: 'numeric',
    precision: 10,
    scale: 3,
    nullable: true,
    name: 'silo_capacity_kg',
    transformer: new DecimalTransformer(),
  })
  siloCapacityKg?: number;

  /**
   * Lower edge of the speed range over which mass flow tracks drive frequency.
   * Below it an induction motor loses torque and cooling, the auger stick-slips
   * and the hopper bridges — flow stops being proportional to anything. NOT NULL
   * exactly when `dosingMode` is CONTINUOUS.
   */
  @Column({
    type: 'numeric',
    precision: 6,
    scale: 2,
    nullable: true,
    name: 'min_speed_hz',
    transformer: new DecimalTransformer(),
  })
  minSpeedHz?: number;

  /**
   * Upper edge of that range. Above it the screw no longer fills completely per
   * revolution and the drive enters field weakening, so delivered mass falls
   * BELOW the proportional prediction — the dangerous direction, because the
   * model would silently over-promise. NOT NULL exactly when CONTINUOUS.
   */
  @Column({
    type: 'numeric',
    precision: 6,
    scale: 2,
    nullable: true,
    name: 'max_speed_hz',
    transformer: new DecimalTransformer(),
  })
  maxSpeedHz?: number;

  @Column({ type: 'varchar', length: 20, name: 'dispense_control' })
  dispenseControl!: FeederDispenseControl;

  /**
   * sensor-service `sensors.id` of the load cell / mass sensor under this
   * feeder's silo. Cross-service soft reference — farm-service cannot FK into
   * the sensor schema, so "this id names something real" is proved the strongest
   * way available: `feeder_silo_mass_latest` only ever holds a row for a sensor
   * that has actually reported a mass, and the dose planner refuses a
   * weight-based feeder whose reading is missing or stale.
   *
   * NOT NULL exactly when `dispenseControl` is WEIGHT_BASED.
   */
  @Column({ type: 'uuid', nullable: true, name: 'weight_sensor_id' })
  weightSensorId?: string;

  @Column({ type: 'text', nullable: true })
  notes?: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  @Column({ type: 'uuid', nullable: true, name: 'created_by' })
  createdBy?: string;

  @Column({ type: 'uuid', nullable: true, name: 'updated_by' })
  updatedBy?: string;
}
