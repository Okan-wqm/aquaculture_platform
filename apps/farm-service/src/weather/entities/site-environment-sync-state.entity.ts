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
