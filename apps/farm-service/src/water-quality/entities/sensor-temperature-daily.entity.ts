import { Entity, PrimaryColumn, Column } from 'typeorm';
import { DecimalTransformer } from '@aquaculture/backend-common/database';

/**
 * SensorTemperatureDaily — farm-side per-sensor per-day temperature rollup
 * (RPT-005). Fed by `SensorTemperatureProjectionListener` from the same
 * `SensorReading` NATS stream as `SensorTemperatureLatest`, but accumulated
 * per day so a regulatory report for period P carries P's representative
 * temperature (`sumC`/`sampleCount`) rather than wall-clock "now".
 *
 * `lastMeasuredAt` is the idempotency watermark: the projection only advances
 * a row on a strictly newer reading, so at-least-once redelivery cannot
 * double-count. Reads/writes go through raw SQL (projection + period aggregate);
 * this entity exists for the tenant-fanout registration + schema parity.
 *
 * Per-tenant table (omits `schema:`; search_path routes it into `tenant_<uuid>`).
 */
@Entity('sensor_temperature_daily')
export class SensorTemperatureDaily {
  @PrimaryColumn('uuid')
  tenantId: string;

  /** sensor-service `sensors.id`. */
  @PrimaryColumn('uuid')
  sensorId: string;

  /** UTC calendar day of the accumulated readings. */
  @PrimaryColumn({ type: 'date' })
  day: string;

  /** Sum of the day's readings (°C) — period mean = sumC / sampleCount. */
  @Column({ type: 'decimal', precision: 14, scale: 2, transformer: new DecimalTransformer() })
  sumC: number;

  @Column({ type: 'decimal', precision: 6, scale: 2, transformer: new DecimalTransformer() })
  minC: number;

  @Column({ type: 'decimal', precision: 6, scale: 2, transformer: new DecimalTransformer() })
  maxC: number;

  @Column({ type: 'int' })
  sampleCount: number;

  /** Idempotency watermark — the newest reading folded into this day's row. */
  @Column({ type: 'timestamptz' })
  lastMeasuredAt: Date;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  updatedAt: Date;
}
