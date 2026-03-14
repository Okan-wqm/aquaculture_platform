/**
 * Marine Observation Entity
 * Open-Meteo Marine API verilerini saklayan tablo
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  Unique,
} from 'typeorm';
import { DecimalTransformer } from '@aquaculture/backend-common';
import { ObjectType, Field, ID, Float } from '@nestjs/graphql';
import { WeatherDataType } from './weather-observation.entity';

@ObjectType()
@Entity('marine_observations')
@Unique('uq_marine_obs', ['tenantId', 'siteId', 'observedAt', 'dataType'])
@Index(['tenantId'])
@Index(['tenantId', 'siteId', 'observedAt'])
export class MarineObservation {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Field()
  @Column({ type: 'uuid', name: 'site_id' })
  siteId!: string;

  @Field()
  @Column({ type: 'timestamptz', name: 'observed_at' })
  observedAt!: Date;

  @Field(() => WeatherDataType)
  @Column({
    type: 'varchar',
    length: 20,
    name: 'data_type',
    default: WeatherDataType.FORECAST,
  })
  dataType!: WeatherDataType;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 5, scale: 2, nullable: true, transformer: new DecimalTransformer(), name: 'wave_height' })
  waveHeight?: number;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 5, scale: 1, nullable: true, transformer: new DecimalTransformer(), name: 'wave_direction' })
  waveDirection?: number;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 5, scale: 2, nullable: true, transformer: new DecimalTransformer(), name: 'wave_period' })
  wavePeriod?: number;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 5, scale: 2, nullable: true, transformer: new DecimalTransformer(), name: 'swell_wave_height' })
  swellWaveHeight?: number;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 5, scale: 1, nullable: true, transformer: new DecimalTransformer(), name: 'swell_wave_direction' })
  swellWaveDirection?: number;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 5, scale: 2, nullable: true, transformer: new DecimalTransformer(), name: 'swell_wave_period' })
  swellWavePeriod?: number;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 5, scale: 3, nullable: true, transformer: new DecimalTransformer(), name: 'ocean_current_velocity' })
  oceanCurrentVelocity?: number;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 5, scale: 1, nullable: true, transformer: new DecimalTransformer(), name: 'ocean_current_direction' })
  oceanCurrentDirection?: number;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 5, scale: 2, nullable: true, transformer: new DecimalTransformer(), name: 'sea_surface_temperature' })
  seaSurfaceTemperature?: number;

  @Field()
  @Column({ type: 'timestamptz', name: 'fetched_at', default: () => 'NOW()' })
  fetchedAt!: Date;

  @Field()
  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @Field()
  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
