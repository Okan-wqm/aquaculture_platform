/**
 * Frozen legacy weather-sync settings row.
 *
 * The Open-Meteo reader, writer, scheduler, resolver, and tenant settings UI
 * are retired. This persistence entity remains registered only so existing
 * tenant schemas keep the baseline table during the environmental-monitoring
 * contract transition. It is deliberately not a GraphQL type and has no
 * runtime reader or writer.
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('weather_settings')
export class WeatherSettings {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id', unique: true })
  tenantId!: string;

  @Column({ type: 'int', name: 'sync_interval_minutes', default: 60 })
  syncIntervalMinutes!: number;

  @Column({ type: 'int', name: 'forecast_days', default: 7 })
  forecastDays!: number;

  @Column({ type: 'boolean', default: true })
  enabled!: boolean;

  @Column({ type: 'timestamptz', name: 'last_synced_at', nullable: true })
  lastSyncedAt?: Date;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
