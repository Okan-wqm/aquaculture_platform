import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  VersionColumn,
  Index,
  Unique,
} from 'typeorm';
import { ObjectType, Field, ID, Int, registerEnumType } from '@nestjs/graphql';
import GraphQLJSON from 'graphql-type-json';

/**
 * Configuration value types
 */
export enum ConfigValueType {
  STRING = 'string',
  NUMBER = 'number',
  BOOLEAN = 'boolean',
  JSON = 'json',
  SECRET = 'secret',
}

registerEnumType(ConfigValueType, {
  name: 'ConfigValueType',
  description: 'Type of configuration value',
});

/**
 * Configuration environments
 */
export enum ConfigEnvironment {
  DEVELOPMENT = 'development',
  STAGING = 'staging',
  PRODUCTION = 'production',
  ALL = 'all',
}

registerEnumType(ConfigEnvironment, {
  name: 'ConfigEnvironment',
  description: 'Environment for configuration',
});

/**
 * Configuration Entity
 * Stores centralized configuration for all services
 * Supports multi-tenancy, versioning
 * Encryption for secrets is delegated to EncryptionService
 */
@ObjectType()
@Entity('configurations', { schema: 'config' })
@Unique(['tenantId', 'service', 'key', 'environment'])
@Index(['tenantId', 'service'])
@Index(['service', 'key'])
@Index(['isActive'])
export class Configuration {
  @PrimaryGeneratedColumn('uuid')
  @Field(() => ID)
  id!: string;

  /** SYSTEM_TENANT_ID ('00000000-0000-0000-0000-000000000000') for system-wide configs */
  @Column({ type: 'uuid', name: 'tenant_id' })
  @Index()
  @Field()
  tenantId!: string;

  @Column({ length: 100 })
  @Index()
  @Field()
  service!: string; // 'auth-service', 'farm-service', etc.

  @Column({ length: 255 })
  @Field()
  key!: string; // 'max_login_attempts', 'session_timeout'

  @Column('text')
  @Field()
  value!: string; // Encrypted if isSecret=true (handled by EncryptionService)

  @Column({
    type: 'enum',
    enum: ConfigValueType,
    default: ConfigValueType.STRING,
    name: 'value_type',
  })
  @Field(() => ConfigValueType)
  valueType!: ConfigValueType;

  @Column({
    type: 'enum',
    enum: ConfigEnvironment,
    default: ConfigEnvironment.ALL,
  })
  @Field(() => ConfigEnvironment)
  environment!: ConfigEnvironment;

  @Column({ length: 500, nullable: true })
  @Field({ nullable: true })
  description?: string;

  @Column({ default: false, name: 'is_secret' })
  @Field()
  isSecret!: boolean; // If true, value is encrypted (by EncryptionService)

  @Column({ default: true, name: 'is_active' })
  @Field()
  isActive!: boolean;

  @Column({ type: 'timestamp', nullable: true, name: 'deleted_at' })
  @Field({ nullable: true })
  deletedAt?: Date | null;

  @Column({ type: 'varchar', nullable: true, length: 100, name: 'deleted_by' })
  @Field({ nullable: true })
  deletedBy?: string | null;

  @Column({ type: 'varchar', nullable: true, length: 255, name: 'delete_reason' })
  @Field({ nullable: true })
  deleteReason?: string | null;

  @Column({ type: 'timestamp', nullable: true, name: 'retention_until' })
  @Field({ nullable: true })
  retentionUntil?: Date | null;

  @Column({ default: false, name: 'suppress_fallback' })
  @Field()
  suppressFallback!: boolean;

  @Column({ nullable: true, length: 255, name: 'default_value' })
  @Field({ nullable: true })
  defaultValue?: string;

  @Column('jsonb', { name: 'validation_rules', nullable: true })
  @Field(() => GraphQLJSON, { nullable: true })
  validationRules?: Record<string, unknown>; // { min: 1, max: 100 } for numbers

  @Column({ nullable: true, length: 50 })
  @Field({ nullable: true })
  category?: string; // 'security', 'performance', 'features'

  @Column('text', { array: true, nullable: true })
  @Field(() => [String], { nullable: true })
  tags?: string[];

  @CreateDateColumn({ name: 'created_at' })
  @Field()
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  @Field()
  updatedAt!: Date;

  @Column({ nullable: true, length: 100, name: 'created_by' })
  @Field({ nullable: true })
  createdBy?: string;

  @Column({ nullable: true, length: 100, name: 'updated_by' })
  @Field({ nullable: true })
  updatedBy?: string;

  @VersionColumn()
  @Field(() => Int)
  version!: number;

  /**
   * Get typed value.
   * For SECRET type, returns raw value as string — decryption is handled by the service layer.
   */
  getTypedValue<T = unknown>(): T {
    const rawValue = this.value;

    switch (this.valueType) {
      case ConfigValueType.NUMBER: {
        const num = Number(rawValue);
        if (rawValue.trim() === '' || !Number.isFinite(num)) {
          return NaN as T;
        }
        return num as T;
      }
      case ConfigValueType.BOOLEAN:
        return (rawValue === 'true' || rawValue === '1') as T;
      case ConfigValueType.JSON:
        return JSON.parse(rawValue) as T;
      case ConfigValueType.SECRET:
        return rawValue as T;
      default:
        return rawValue as T;
    }
  }

  isSecretValue(): boolean {
    return this.valueType === ConfigValueType.SECRET || this.isSecret === true;
  }
}

/**
 * Configuration History Entity
 * Tracks all changes for audit purposes
 */
@Entity('configuration_history', { schema: 'config' })
@Index(['configurationId', 'changedAt'])
@Index(['tenantId', 'changedAt'])
@ObjectType()
export class ConfigurationHistory {
  @PrimaryGeneratedColumn('uuid')
  @Field(() => ID)
  id!: string;

  @Column({ type: 'uuid', name: 'configuration_id' })
  @Index()
  @Field()
  configurationId!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  @Field()
  tenantId!: string;

  @Column({ length: 100 })
  @Field()
  service!: string;

  @Column({ length: 255 })
  @Field()
  key!: string;

  @Column('text', { name: 'previous_value' })
  @Field()
  previousValue!: string;

  @Column('text', { name: 'new_value' })
  @Field()
  newValue!: string;

  @Column({ length: 100, name: 'changed_by' })
  @Field()
  changedBy!: string;

  @Column({ name: 'changed_at' })
  @Field()
  changedAt!: Date;

  @Column({ length: 255, nullable: true, name: 'change_reason' })
  @Field({ nullable: true })
  changeReason?: string;
}
