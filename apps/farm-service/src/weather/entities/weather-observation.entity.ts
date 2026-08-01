/**
 * Canonical MET Norway observations plus read-isolated rows retained from the
 * retired Open-Meteo pipeline.
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  JoinColumn,
  ManyToOne,
} from 'typeorm';
import { DecimalTransformer } from '@aquaculture/backend-common/database';
import { ObjectType, Field, ID, Float, registerEnumType } from '@nestjs/graphql';

import { Site } from '../../site/entities/site.entity';

import {
  EnvironmentProvider,
  EnvironmentQualityStatus,
  EnvironmentSemanticClass,
} from './environment-observation.types';

export enum WeatherDataType {
  FORECAST = 'forecast',
  HISTORICAL = 'historical',
}
registerEnumType(WeatherDataType, {
  name: 'WeatherDataType',
  description: 'Tahmin mi geçmiş veri mi',
});

@ObjectType()
@Entity('weather_observations')
@Index(['tenantId'])
@Index(['tenantId', 'siteId', 'observedAt'])
@Index('uq_weather_obs_legacy', ['tenantId', 'siteId', 'observedAt', 'dataType'], {
  unique: true,
  where: '"provider" IS NULL',
})
@Index(
  'uq_weather_obs_provider_revision',
  [
    'tenantId',
    'siteId',
    'provider',
    'datasetId',
    'sourceRunKey',
    'observedAt',
    'dataType',
    'monitoringLocationRevision',
  ],
  { unique: true, where: '"provider" IS NOT NULL' },
)
@Index('idx_weather_obs_canonical_run', [
  'tenantId',
  'siteId',
  'provider',
  'datasetId',
  'sourceRunKey',
  'observedAt',
])
@Index('idx_weather_obs_retention', ['observedAt'], { where: '"provider" IS NOT NULL' })
@Index(
  'idx_weather_obs_latest_metric',
  [
    'tenantId',
    'siteId',
    'monitoringLocationRevision',
    'observedAt',
    'provider',
    'issuedAt',
    'fetchedAt',
  ],
  { where: '"provider" IS NOT NULL' },
)
export class WeatherObservation {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Field()
  @Column({ type: 'uuid', name: 'site_id' })
  siteId!: string;

  @ManyToOne(() => Site, { onDelete: 'CASCADE' })
  @JoinColumn([
    { name: 'tenant_id', referencedColumnName: 'tenantId' },
    { name: 'site_id', referencedColumnName: 'id' },
  ])
  site!: Site;

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

  /**
   * Null identifies rows written by the pre-provenance Open-Meteo pipeline.
   * Every canonical MET/Frost writer must persist the complete provenance
   * bundle; the database migration enforces all-or-none completeness.
   */
  @Field(() => EnvironmentProvider, { nullable: true })
  @Column({ type: 'varchar', length: 40, nullable: true })
  provider?: EnvironmentProvider | null;

  @Field(() => String, { nullable: true })
  @Column({ type: 'varchar', length: 160, nullable: true, name: 'product_id' })
  productId?: string | null;

  @Field(() => String, { nullable: true })
  @Column({ type: 'varchar', length: 200, nullable: true, name: 'dataset_id' })
  datasetId?: string | null;

  @Field(() => String, { nullable: true })
  @Column({ type: 'varchar', length: 200, nullable: true, name: 'source_run_key' })
  sourceRunKey?: string | null;

  @Field(() => Date, { nullable: true })
  @Column({ type: 'timestamptz', nullable: true, name: 'issued_at' })
  issuedAt?: Date | null;

  @Field(() => EnvironmentSemanticClass, { nullable: true })
  @Column({ type: 'varchar', length: 40, nullable: true, name: 'semantic_class' })
  semanticClass?: EnvironmentSemanticClass | null;

  @Field(() => EnvironmentQualityStatus, { nullable: true })
  @Column({ type: 'varchar', length: 40, nullable: true, name: 'quality_status' })
  qualityStatus?: EnvironmentQualityStatus | null;

  @Field(() => String, { nullable: true })
  @Column({ type: 'varchar', length: 100, nullable: true, name: 'station_id' })
  stationId?: string | null;

  @Field(() => Float, { nullable: true })
  @Column({
    type: 'decimal',
    precision: 10,
    scale: 3,
    nullable: true,
    name: 'station_distance_km',
    transformer: new DecimalTransformer(),
  })
  stationDistanceKm?: number | null;

  @Field(() => Float, { nullable: true })
  @Column({
    type: 'decimal',
    precision: 12,
    scale: 3,
    nullable: true,
    name: 'horizontal_resolution_m',
    transformer: new DecimalTransformer(),
  })
  horizontalResolutionM?: number | null;

  @Field()
  @Column({ type: 'int', default: 1, name: 'monitoring_location_revision' })
  monitoringLocationRevision!: number;

  @Field(() => Float, { nullable: true })
  @Column({
    type: 'decimal',
    precision: 6,
    scale: 2,
    nullable: true,
    transformer: new DecimalTransformer(),
  })
  temperature?: number;

  @Field(() => Float, { nullable: true })
  @Column({
    type: 'decimal',
    precision: 6,
    scale: 2,
    nullable: true,
    name: 'wind_speed',
    transformer: new DecimalTransformer(),
  })
  windSpeed?: number;

  @Field(() => Float, { nullable: true })
  @Column({
    type: 'decimal',
    precision: 5,
    scale: 1,
    nullable: true,
    name: 'wind_direction',
    transformer: new DecimalTransformer(),
  })
  windDirection?: number;

  @Field(() => Float, { nullable: true })
  @Column({
    type: 'decimal',
    precision: 6,
    scale: 2,
    nullable: true,
    name: 'wind_gusts',
    transformer: new DecimalTransformer(),
  })
  windGusts?: number;

  @Field(() => Float, { nullable: true })
  @Column({
    type: 'decimal',
    precision: 6,
    scale: 2,
    nullable: true,
    transformer: new DecimalTransformer(),
  })
  precipitation?: number;

  @Field(() => Float, { nullable: true })
  @Column({
    type: 'decimal',
    precision: 5,
    scale: 1,
    nullable: true,
    name: 'cloud_cover',
    transformer: new DecimalTransformer(),
  })
  cloudCover?: number;

  @Field(() => Float, { nullable: true })
  @Column({
    type: 'decimal',
    precision: 7,
    scale: 2,
    nullable: true,
    name: 'pressure_msl',
    transformer: new DecimalTransformer(),
  })
  pressureMsl?: number;

  @Field(() => Float, { nullable: true })
  @Column({
    type: 'decimal',
    precision: 5,
    scale: 1,
    nullable: true,
    name: 'relative_humidity',
    transformer: new DecimalTransformer(),
  })
  relativeHumidity?: number;

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
