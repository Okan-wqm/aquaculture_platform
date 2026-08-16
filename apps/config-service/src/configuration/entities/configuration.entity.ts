import { ConfigurationKeyId } from '@aquaculture/configuration-contracts';
import { Field, ID, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
  VersionColumn,
} from 'typeorm';

export enum ConfigEnvironment {
  DEVELOPMENT = 'development',
  STAGING = 'staging',
  PRODUCTION = 'production',
  ALL = 'all',
}

registerEnumType(ConfigEnvironment, {
  name: 'ConfigEnvironment',
  description: 'Environment partition for a configuration snapshot',
});

/**
 * Mutable configuration state. All semantic metadata lives in the signed
 * configuration catalog; rows persist only a catalog ID and operator state.
 */
@ObjectType()
@Entity('configurations', { schema: 'config' })
@Unique('UQ_configurations_scope_catalog_environment', ['tenantId', 'catalogId', 'environment'])
@Index(['tenantId', 'environment'])
@Index(['catalogId'])
@Index(['isActive'])
export class Configuration {
  @PrimaryGeneratedColumn('uuid')
  @Field(() => ID)
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  @Index()
  @Field()
  tenantId!: string;

  @Column({ type: 'varchar', length: 64, name: 'catalog_id' })
  @Field(() => ConfigurationKeyId)
  catalogId!: ConfigurationKeyId;

  /** Canonical string or encrypted ciphertext, interpreted only by catalog type. */
  @Column('text')
  value!: string;

  @Column({ type: 'enum', enum: ConfigEnvironment, default: ConfigEnvironment.ALL })
  @Field(() => ConfigEnvironment)
  environment!: ConfigEnvironment;

  @Column({ default: true, name: 'is_active' })
  isActive!: boolean;

  @Column({ type: 'timestamptz', nullable: true, name: 'deleted_at' })
  deletedAt?: Date | null;

  @Column({ type: 'varchar', nullable: true, length: 100, name: 'deleted_by' })
  deletedBy?: string | null;

  @Column({ type: 'varchar', nullable: true, length: 255, name: 'delete_reason' })
  deleteReason?: string | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'retention_until' })
  retentionUntil?: Date | null;

  @Column({ default: false, name: 'suppress_fallback' })
  suppressFallback!: boolean;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  @Column({ type: 'varchar', nullable: true, length: 100, name: 'created_by' })
  createdBy?: string;

  @Column({ type: 'varchar', nullable: true, length: 100, name: 'updated_by' })
  updatedBy?: string;

  @VersionColumn()
  @Field(() => Int)
  version!: number;
}

/** Immutable audit history written in the same transaction as each operation. */
@Entity('configuration_history', { schema: 'config' })
@Index(['configurationId', 'changedAt'])
@Index(['tenantId', 'changedAt'])
export class ConfigurationHistory {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'configuration_id' })
  configurationId!: string;

  @Column({ type: 'uuid', name: 'operation_id' })
  operationId!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'varchar', length: 64, name: 'catalog_id' })
  catalogId!: ConfigurationKeyId;

  @Column('text', { name: 'previous_value' })
  previousValue!: string;

  @Column('text', { name: 'new_value' })
  newValue!: string;

  @Column({ length: 100, name: 'changed_by' })
  changedBy!: string;

  @Column({ type: 'timestamptz', name: 'changed_at' })
  changedAt!: Date;

  @Column({ length: 255, nullable: true, name: 'change_reason' })
  changeReason?: string;
}
