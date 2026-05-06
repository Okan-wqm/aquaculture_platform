/**
 * Weather Settings Entity
 * Tenant bazlı hava durumu sync ayarları
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ObjectType, Field, ID, Int } from '@nestjs/graphql';

@ObjectType()
@Entity('weather_settings')
export class WeatherSettings {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column({ type: 'uuid', name: 'tenant_id', unique: true })
  tenantId!: string;

  @Field(() => Int)
  @Column({ type: 'int', name: 'sync_interval_minutes', default: 60 })
  syncIntervalMinutes!: number;

  @Field(() => Int)
  @Column({ type: 'int', name: 'forecast_days', default: 7 })
  forecastDays!: number;

  @Field()
  @Column({ type: 'boolean', default: true })
  enabled!: boolean;

  @Field({ nullable: true })
  @Column({ type: 'timestamptz', name: 'last_synced_at', nullable: true })
  lastSyncedAt?: Date;

  @Field()
  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @Field()
  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
