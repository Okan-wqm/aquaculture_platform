/**
 * Canonical Copernicus Marine model observations plus read-isolated rows
 * retained from the retired Open-Meteo pipeline.
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
import { ObjectType, Field, ID, Float } from '@nestjs/graphql';

import { Site } from '../../site/entities/site.entity';
import { WeatherDataType } from './weather-observation.entity';
import {
  EnvironmentProvider,
  EnvironmentQualityStatus,
  EnvironmentSemanticClass,
} from './environment-observation.types';

@ObjectType()
@Entity('marine_observations')
@Index(['tenantId'])
@Index(['tenantId', 'siteId', 'observedAt'])
@Index('uq_marine_obs_legacy', ['tenantId', 'siteId', 'observedAt', 'dataType'], {
  unique: true,
  where: '"provider" IS NULL',
})
@Index('idx_marine_obs_canonical_run', [
  'tenantId',
  'siteId',
  'provider',
  'datasetId',
  'sourceRunKey',
  'observedAt',
  'modelDepthM',
])
@Index('idx_marine_obs_retention', ['observedAt'], { where: '"provider" IS NOT NULL' })
@Index(
  'idx_marine_obs_latest_metric',
  [
    'tenantId',
    'siteId',
    'monitoringLocationRevision',
    'observedAt',
    'provider',
    'issuedAt',
    'fetchedAt',
    'modelDepthM',
  ],
  { where: '"provider" IS NOT NULL' },
)
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
  @Column({ type: 'varchar', length: 100, nullable: true, name: 'variable_set_id' })
  variableSetId?: string | null;

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

  @Field(() => Float, { nullable: true })
  @Column({
    type: 'decimal',
    precision: 5,
    scale: 2,
    nullable: true,
    transformer: new DecimalTransformer(),
    name: 'wave_height',
  })
  waveHeight?: number;

  @Field(() => Float, { nullable: true })
  @Column({
    type: 'decimal',
    precision: 5,
    scale: 1,
    nullable: true,
    transformer: new DecimalTransformer(),
    name: 'wave_direction',
  })
  waveDirection?: number;

  @Field(() => Float, { nullable: true })
  @Column({
    type: 'decimal',
    precision: 5,
    scale: 2,
    nullable: true,
    transformer: new DecimalTransformer(),
    name: 'wave_period',
  })
  wavePeriod?: number;

  @Field(() => Float, { nullable: true })
  @Column({
    type: 'decimal',
    precision: 5,
    scale: 2,
    nullable: true,
    transformer: new DecimalTransformer(),
    name: 'swell_wave_height',
  })
  swellWaveHeight?: number;

  @Field(() => Float, { nullable: true })
  @Column({
    type: 'decimal',
    precision: 5,
    scale: 1,
    nullable: true,
    transformer: new DecimalTransformer(),
    name: 'swell_wave_direction',
  })
  swellWaveDirection?: number;

  @Field(() => Float, { nullable: true })
  @Column({
    type: 'decimal',
    precision: 5,
    scale: 2,
    nullable: true,
    transformer: new DecimalTransformer(),
    name: 'swell_wave_period',
  })
  swellWavePeriod?: number;

  @Field(() => Float, { nullable: true })
  @Column({
    type: 'decimal',
    precision: 5,
    scale: 3,
    nullable: true,
    transformer: new DecimalTransformer(),
    name: 'ocean_current_velocity',
  })
  oceanCurrentVelocity?: number;

  @Field(() => Float, { nullable: true })
  @Column({
    type: 'decimal',
    precision: 5,
    scale: 1,
    nullable: true,
    transformer: new DecimalTransformer(),
    name: 'ocean_current_direction',
  })
  oceanCurrentDirection?: number;

  @Field(() => Float, { nullable: true })
  @Column({
    type: 'decimal',
    precision: 5,
    scale: 2,
    nullable: true,
    transformer: new DecimalTransformer(),
    name: 'sea_surface_temperature',
  })
  seaSurfaceTemperature?: number;

  @Field(() => Float, { nullable: true })
  @Column({
    type: 'decimal',
    precision: 8,
    scale: 4,
    nullable: true,
    transformer: new DecimalTransformer(),
  })
  salinity?: number | null;

  @Field(() => Float, { nullable: true })
  @Column({
    type: 'decimal',
    precision: 12,
    scale: 5,
    nullable: true,
    name: 'dissolved_oxygen',
    transformer: new DecimalTransformer(),
  })
  dissolvedOxygen?: number | null;

  @Field(() => Float, { nullable: true })
  @Column({
    type: 'decimal',
    precision: 12,
    scale: 6,
    nullable: true,
    name: 'model_chlorophyll',
    transformer: new DecimalTransformer(),
  })
  modelChlorophyll?: number | null;

  @Field(() => Float, { nullable: true })
  @Column({
    type: 'decimal',
    precision: 10,
    scale: 3,
    nullable: true,
    name: 'requested_depth_m',
    transformer: new DecimalTransformer(),
  })
  requestedDepthM?: number | null;

  @Field(() => Float, { nullable: true })
  @Column({
    type: 'decimal',
    precision: 10,
    scale: 3,
    nullable: true,
    name: 'model_depth_m',
    transformer: new DecimalTransformer(),
  })
  modelDepthM?: number | null;

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

  @Field(() => Float, { nullable: true })
  @Column({
    type: 'decimal',
    precision: 12,
    scale: 3,
    nullable: true,
    name: 'grid_cell_distance_m',
    transformer: new DecimalTransformer(),
  })
  gridCellDistanceM?: number | null;

  @Field(() => Float, { nullable: true })
  @Column({
    type: 'decimal',
    precision: 5,
    scale: 2,
    nullable: true,
    name: 'coverage_percent',
    transformer: new DecimalTransformer(),
  })
  coveragePercent?: number | null;

  @Field()
  @Column({ type: 'int', default: 1, name: 'monitoring_location_revision' })
  monitoringLocationRevision!: number;

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
