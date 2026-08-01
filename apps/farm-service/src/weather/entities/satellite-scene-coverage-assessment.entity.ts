import { DecimalTransformer } from '@aquaculture/backend-common/database';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

import { Site } from '../../site/entities/site.entity';
import { EnvironmentQualityStatus, SatelliteCoverageStatus } from './environment-observation.types';
import { SatelliteSceneObservation } from './satellite-scene-observation.entity';

@Entity('satellite_scene_coverage_assessments')
@Unique('uq_satellite_coverage_scene_method', [
  'tenantId',
  'siteId',
  'sceneId',
  'monitoringLocationRevision',
  'coverageMethod',
])
@Index('idx_satellite_coverage_site_created', ['tenantId', 'siteId', 'createdAt'])
export class SatelliteSceneCoverageAssessment {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'uuid', name: 'site_id' })
  siteId!: string;

  @ManyToOne(() => Site, { onDelete: 'CASCADE' })
  @JoinColumn([
    { name: 'tenant_id', referencedColumnName: 'tenantId' },
    { name: 'site_id', referencedColumnName: 'id' },
  ])
  site!: Site;

  @Column({ type: 'varchar', length: 512, name: 'scene_id' })
  sceneId!: string;

  @Column({ type: 'int', name: 'monitoring_location_revision' })
  monitoringLocationRevision!: number;

  @ManyToOne(() => SatelliteSceneObservation, (scene) => scene.coverageAssessments, {
    onDelete: 'CASCADE',
  })
  @JoinColumn([
    { name: 'tenant_id', referencedColumnName: 'tenantId' },
    { name: 'site_id', referencedColumnName: 'siteId' },
    { name: 'scene_id', referencedColumnName: 'sceneId' },
    {
      name: 'monitoring_location_revision',
      referencedColumnName: 'monitoringLocationRevision',
    },
  ])
  scene!: SatelliteSceneObservation;

  @Column({ type: 'varchar', length: 32, name: 'coverage_status' })
  coverageStatus!: SatelliteCoverageStatus;

  @Column({ type: 'varchar', length: 100, name: 'coverage_method' })
  coverageMethod!: string;

  @Column({
    type: 'decimal',
    precision: 5,
    scale: 2,
    nullable: true,
    name: 'coverage_percent',
    transformer: new DecimalTransformer(),
  })
  coveragePercent!: number | null;

  @Column({ type: 'int', nullable: true, name: 'coverage_sample_count' })
  coverageSampleCount!: number | null;

  @Column({ type: 'varchar', length: 32, name: 'quality_status' })
  qualityStatus!: EnvironmentQualityStatus;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}
