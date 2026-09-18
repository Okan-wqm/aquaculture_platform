import { Field, ID, Int, ObjectType } from '@nestjs/graphql';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

import { Site } from '../../site/entities/site.entity';
import { EnvironmentProvider, EnvironmentSyncStatus } from './environment-observation.types';
import { Check } from 'typeorm';

@ObjectType()
@Entity('site_environment_sync_state')
@Unique('uq_site_environment_sync_provider_revision', [
  'tenantId',
  'siteId',
  'provider',
  'monitoringLocationRevision',
])
@Index('idx_site_environment_sync_due', ['status', 'nextRunAt'])
@Index('idx_site_environment_sync_lease', ['leaseExpiresAt'])
// The five CHECK contracts the migration layers onto the table, declared
// here so the entity↔DB drift scanner sees them (they were SQL-only and
// flagged as orphaned). Verbatim from the migration DDL.
@Check(
  'CHK_site_environment_sync_counts',
  `consecutive_failures >= 0 AND monitoring_location_revision >= 1 AND expected_scope_count >= 0 AND successful_scope_count >= 0 AND failed_scope_count >= 0 AND no_data_scope_count >= 0 AND out_of_coverage_scope_count >= 0 AND expected_scope_count = successful_scope_count + failed_scope_count AND no_data_scope_count + out_of_coverage_scope_count <= successful_scope_count`,
)
@Check(
  'CHK_site_environment_sync_lease',
  `((status = 'RUNNING' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL AND last_attempt_at IS NOT NULL AND lease_expires_at > last_attempt_at) OR (status <> 'RUNNING' AND lease_token IS NULL AND lease_expires_at IS NULL))`,
)
@Check(
  'CHK_site_environment_sync_outcome',
  `((status IN ('PENDING','RUNNING','READY','NO_DATA','OUT_OF_COVERAGE') AND error_code IS NULL) OR (status IN ('PARTIAL_FAILURE','PROVIDER_UNAVAILABLE','CONFIGURATION_ERROR') AND error_code IS NOT NULL))`,
)
@Check(
  'CHK_site_environment_sync_provider',
  `provider IN ('MET_LOCATIONFORECAST','MET_FROST','CMEMS','CDSE_SENTINEL_2')`,
)
@Check(
  'CHK_site_environment_sync_status',
  `status IN ('PENDING','RUNNING','READY','PARTIAL_FAILURE','NO_DATA','OUT_OF_COVERAGE','PROVIDER_UNAVAILABLE','CONFIGURATION_ERROR')`,
)
export class SiteEnvironmentSyncState {
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

  @Field(() => EnvironmentProvider)
  @Column({ type: 'varchar', length: 40 })
  provider!: EnvironmentProvider;

  @Field(() => EnvironmentSyncStatus)
  @Column({ type: 'varchar', length: 40 })
  status!: EnvironmentSyncStatus;

  @Field(() => String, { nullable: true })
  @Column({ type: 'varchar', length: 2048, nullable: true })
  cursor?: string | null;

  @Field(() => Date, { nullable: true })
  @Column({ type: 'timestamptz', nullable: true, name: 'last_attempt_at' })
  lastAttemptAt?: Date | null;

  @Field(() => Date, { nullable: true })
  @Column({ type: 'timestamptz', nullable: true, name: 'last_success_at' })
  lastSuccessAt?: Date | null;

  @Field(() => Date, { nullable: true })
  @Column({ type: 'timestamptz', nullable: true, name: 'next_run_at' })
  nextRunAt?: Date | null;

  @Field(() => String, { nullable: true })
  @Column({ type: 'varchar', length: 100, nullable: true, name: 'error_code' })
  errorCode?: string | null;

  @Field(() => Int)
  @Column({ type: 'int', default: 0, name: 'consecutive_failures' })
  consecutiveFailures!: number;

  @Field(() => Int)
  @Column({ type: 'int', default: 0, name: 'expected_scope_count' })
  expectedScopeCount!: number;

  @Field(() => Int)
  @Column({ type: 'int', default: 0, name: 'successful_scope_count' })
  successfulScopeCount!: number;

  @Field(() => Int)
  @Column({ type: 'int', default: 0, name: 'failed_scope_count' })
  failedScopeCount!: number;

  @Field(() => Int)
  @Column({ type: 'int', default: 0, name: 'no_data_scope_count' })
  noDataScopeCount!: number;

  @Field(() => Int)
  @Column({ type: 'int', default: 0, name: 'out_of_coverage_scope_count' })
  outOfCoverageScopeCount!: number;

  @Field(() => String, { nullable: true })
  @Column({ type: 'uuid', nullable: true, name: 'lease_token' })
  leaseToken?: string | null;

  @Field(() => Date, { nullable: true })
  @Column({ type: 'timestamptz', nullable: true, name: 'lease_expires_at' })
  leaseExpiresAt?: Date | null;

  @Field(() => Int)
  @Column({ type: 'int', name: 'monitoring_location_revision' })
  monitoringLocationRevision!: number;

  @Field()
  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @Field()
  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
