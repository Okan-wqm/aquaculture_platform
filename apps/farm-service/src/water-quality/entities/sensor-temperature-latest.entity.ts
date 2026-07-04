import { Entity, PrimaryColumn, Column } from 'typeorm';
import { DecimalTransformer } from '@aquaculture/backend-common/database';

/**
 * SensorTemperatureLatest — farm-side read model of the latest water temperature
 * reported by each sensor-service sensor.
 *
 * Fed by `SensorTemperatureProjectionListener` from the sensor-service
 * `SensorReading` NATS event stream, so the feeding-rate calc reads temperature
 * LOCALLY (no synchronous cross-service call, no cross-schema grant — the old
 * direct `sensor.sensor_readings` query was prod-broken). One row per
 * (tenant, sensor); newest reading wins.
 *
 * Per-tenant table (omits `schema:`; search_path routes it into `tenant_<uuid>`).
 */
@Entity('sensor_temperature_latest')
export class SensorTemperatureLatest {
  @PrimaryColumn('uuid')
  tenantId: string;

  /** sensor-service `sensors.id`. */
  @PrimaryColumn('uuid')
  sensorId: string;

  @Column({ type: 'decimal', precision: 6, scale: 2, transformer: new DecimalTransformer() })
  temperatureC: number;

  @Column({ type: 'timestamptz' })
  measuredAt: Date;
}
