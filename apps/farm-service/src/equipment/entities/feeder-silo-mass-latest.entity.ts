/**
 * FeederSiloMassLatest — farm-side read model of the latest mass reported by a
 * sensor-service mass sensor (the load cells under a feeder's silo).
 *
 * WHAT: one row per (tenant, sensor); newest reading wins. Fed by
 * `SensorMassProjectionListener` from the sensor-service `SensorReading` NATS
 * stream, exactly as `SensorTemperatureLatest` is fed for water temperature.
 *
 * WHY it exists at all — this row is the ONLY honest answer to "does this feeder
 * really have a weight source?". `feeder_capabilities.weight_sensor_id` is a
 * cross-service uuid, and a CHECK constraint can force it to be present but
 * cannot force it to be TRUE: a mistyped uuid, or a load cell that was specified
 * and never installed, satisfies "not null" perfectly. A projection row proves
 * something stronger and exactly what matters — a measurement actually arrived,
 * and here is when. `FeederDoseDirectiveService` refuses a weight-based feeder
 * whose row is absent or stale, so a farm that claims a load cell it does not
 * have gets a refusal at planning time instead of a dispense that waits forever
 * on a number that never comes.
 *
 * WHY the same shape (latest-only, no history): the question is "is the source
 * alive and what does it say right now". A time series of silo mass is a
 * different product — it belongs in the sensor service that already stores one.
 *
 * Per-tenant table (omits `schema:`; search_path routes it into `tenant_<uuid>`).
 *
 * @module Equipment/Entities
 */
import { Entity, PrimaryColumn, Column } from 'typeorm';
import { DecimalTransformer } from '@aquaculture/backend-common/database';

@Entity('feeder_silo_mass_latest')
export class FeederSiloMassLatest {
  @PrimaryColumn('uuid')
  tenantId!: string;

  /** sensor-service `sensors.id`. */
  @PrimaryColumn('uuid')
  sensorId!: string;

  @Column({ type: 'decimal', precision: 12, scale: 3, transformer: new DecimalTransformer() })
  massKg!: number;

  @Column({ type: 'timestamptz' })
  measuredAt!: Date;
}
