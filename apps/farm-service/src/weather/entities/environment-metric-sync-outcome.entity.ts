import { Field, ID, Int, ObjectType } from '@nestjs/graphql';
import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import {
  EnvironmentMetric,
  EnvironmentProvider,
  EnvironmentSyncScopeKind,
  EnvironmentSyncScopeOutcome,
} from './environment-observation.types';
import { SiteEnvironmentSyncState } from './site-environment-sync-state.entity';

@ObjectType()
@Entity('environment_metric_sync_outcomes')
@Index('idx_environment_metric_sync_outcome_lookup', [
  'tenantId',
  'siteId',
  'monitoringLocationRevision',
  'provider',
  'metric',
])
export class EnvironmentMetricSyncOutcome {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Field()
  @Column({ type: 'uuid', name: 'site_id' })
  siteId!: string;

  @Field(() => EnvironmentProvider)
  @Column({ type: 'varchar', length: 40 })
  provider!: EnvironmentProvider;

  @Field(() => EnvironmentMetric, { nullable: true })
  @Column({ type: 'varchar', length: 50, nullable: true })
  metric!: EnvironmentMetric | null;

  @Field(() => EnvironmentSyncScopeKind)
  @Column({ type: 'varchar', length: 40, name: 'scope_kind' })
  scopeKind!: EnvironmentSyncScopeKind;

  @Field()
  @Column({ type: 'varchar', length: 240, name: 'scope_key' })
  scopeKey!: string;

  @Field(() => Date, { nullable: true })
  @Column({ type: 'timestamptz', nullable: true, name: 'valid_from' })
  validFrom!: Date | null;

  @Field(() => Date, { nullable: true })
  @Column({ type: 'timestamptz', nullable: true, name: 'valid_to' })
  validTo!: Date | null;

  @Field(() => EnvironmentSyncScopeOutcome)
  @Column({ type: 'varchar', length: 40 })
  outcome!: EnvironmentSyncScopeOutcome;

  @Field(() => String, { nullable: true })
  @Column({ type: 'varchar', length: 100, nullable: true, name: 'error_code' })
  errorCode!: string | null;

  @Field(() => Int)
  @Column({ type: 'int', name: 'observation_count' })
  observationCount!: number;

  @Field(() => Int)
  @Column({ type: 'int', name: 'monitoring_location_revision' })
  monitoringLocationRevision!: number;

  @ManyToOne(() => SiteEnvironmentSyncState, { onDelete: 'CASCADE' })
  @JoinColumn([
    { name: 'tenant_id', referencedColumnName: 'tenantId' },
    { name: 'site_id', referencedColumnName: 'siteId' },
    { name: 'provider', referencedColumnName: 'provider' },
    {
      name: 'monitoring_location_revision',
      referencedColumnName: 'monitoringLocationRevision',
    },
  ])
  syncState!: SiteEnvironmentSyncState;

  @Field()
  @Column({ type: 'timestamptz', name: 'completed_at' })
  completedAt!: Date;
}
