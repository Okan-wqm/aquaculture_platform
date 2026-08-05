import { DecimalTransformer } from '@aquaculture/backend-common/database';
import { Field, Float, ID, ObjectType } from '@nestjs/graphql';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  OneToMany,
  Unique,
} from 'typeorm';

import { Site } from '../../site/entities/site.entity';
import { EnvironmentProvider, EnvironmentQualityStatus } from './environment-observation.types';
import { SatelliteSceneCoverageAssessment } from './satellite-scene-coverage-assessment.entity';

@ObjectType()
@Entity('satellite_scene_observations')
@Unique('uq_satellite_scene_site_revision', [
  'tenantId',
  'siteId',
  'sceneId',
  'monitoringLocationRevision',
])
@Index('idx_satellite_scene_site_acquired', ['tenantId', 'siteId', 'acquiredAt'])
@Index('idx_satellite_scene_retention', ['acquiredAt'])
export class SatelliteSceneObservation {
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
  @Column({ type: 'varchar', length: 512, name: 'scene_id' })
  sceneId!: string;

  @Field()
  @Column({ type: 'varchar', length: 100 })
  collection!: string;

  @Field(() => EnvironmentProvider)
  @Column({ type: 'varchar', length: 40, default: EnvironmentProvider.CDSE_SENTINEL_2 })
  provider!: EnvironmentProvider;

  @Field()
  @Column({ type: 'varchar', length: 512, name: 'product_id' })
  productId!: string;

  @Field()
  @Column({ type: 'varchar', length: 200, name: 'dataset_id' })
  datasetId!: string;

  @Field()
  @Column({ type: 'timestamptz', name: 'acquired_at' })
  acquiredAt!: Date;

  @Field(() => Float, { nullable: true })
  @Column({
    type: 'decimal',
    precision: 5,
    scale: 2,
    nullable: true,
    name: 'cloud_cover_percent',
    transformer: new DecimalTransformer(),
  })
  cloudCoverPercent?: number | null;

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

  @OneToMany(() => SatelliteSceneCoverageAssessment, (assessment) => assessment.scene)
  coverageAssessments!: SatelliteSceneCoverageAssessment[];

  @Field(() => EnvironmentQualityStatus)
  @Column({ type: 'varchar', length: 32, name: 'quality_status' })
  qualityStatus!: EnvironmentQualityStatus;

  @Field()
  @Column({ type: 'int', name: 'monitoring_location_revision' })
  monitoringLocationRevision!: number;

  @Field()
  @Column({ type: 'timestamptz', name: 'fetched_at' })
  fetchedAt!: Date;

  @Field()
  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}
