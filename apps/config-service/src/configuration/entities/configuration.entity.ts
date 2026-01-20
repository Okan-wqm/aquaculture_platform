import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  VersionColumn,
  Index,
  Unique,
  BeforeInsert,
  BeforeUpdate,
} from 'typeorm';
import { ObjectType, Field, ID, Int, registerEnumType } from '@nestjs/graphql';
import * as crypto from 'crypto';

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
 * Supports multi-tenancy, encryption for secrets, and versioning
 */
@Entity('configurations')
@Unique(['tenantId', 'service', 'key', 'environment'])
@Index(['tenantId', 'service'])
@Index(['service', 'key'])
@Index(['isActive'])
export class Configuration {
  @PrimaryGeneratedColumn('uuid')
  @Field(() => ID)
  id!: string;

  @Column({ length: 100 })
  @Index()
  @Field()
  tenantId!: string; // 'global' for system-wide configs

  @Column({ length: 100 })
  @Index()
  @Field()
  service!: string; // 'auth-service', 'farm-service', etc.

  @Column({ length: 255 })
  @Field()
  key!: string; // 'max_login_attempts', 'session_timeout'

  @Column('text')
  @Field()
  value!: string; // Encrypted if isSecret=true

  @Column({
    type: 'enum',
    enum: ConfigValueType,
    default: ConfigValueType.STRING,
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

  @Column({ default: false })
  @Field()
  isSecret!: boolean; // If true, value is encrypted

  @Column({ default: true })
  @Field()
  isActive!: boolean;

  @Column({ nullable: true, length: 255 })
  @Field({ nullable: true })
  defaultValue?: string;

  @Column('jsonb', { nullable: true })
  @Field({ nullable: true })
  validationRules?: Record<string, unknown>; // { min: 1, max: 100 } for numbers

  @Column({ nullable: true, length: 50 })
  @Field({ nullable: true })
  category?: string; // 'security', 'performance', 'features'

  @Column('text', { array: true, nullable: true })
  @Field(() => [String], { nullable: true })
  tags?: string[];

  @CreateDateColumn()
  @Field()
  createdAt!: Date;

  @UpdateDateColumn()
  @Field()
  updatedAt!: Date;

  @Column({ nullable: true, length: 100 })
  @Field({ nullable: true })
  createdBy?: string;

  @Column({ nullable: true, length: 100 })
  @Field({ nullable: true })
  updatedBy?: string;

  @VersionColumn()
  @Field(() => Int)
  version!: number;

  // Encryption key from environment
  private static readonly ENCRYPTION_KEY = process.env['CONFIG_ENCRYPTION_KEY'] || 'default-32-char-encryption-key!';
  private static readonly ENCRYPTION_ALGORITHM = 'aes-256-gcm';

  /**
   * Encrypt sensitive values before saving
   */
  @BeforeInsert()
  @BeforeUpdate()
  encryptIfSecret(): void {
    if (this.isSecret && this.value && !this.isEncrypted(this.value)) {
      this.value = this.encrypt(this.value);
    }
  }

  /**
   * Check if value is already encrypted
   */
  private isEncrypted(value: string): boolean {
    try {
      const parsed = JSON.parse(value);
      return parsed.iv && parsed.authTag && parsed.encrypted;
    } catch {
      return false;
    }
  }

  /**
   * Encrypt a value using AES-256-GCM
   */
  private encrypt(text: string): string {
    const iv = crypto.randomBytes(16);
    const key = crypto.scryptSync(Configuration.ENCRYPTION_KEY, 'salt', 32);
    const cipher = crypto.createCipheriv(Configuration.ENCRYPTION_ALGORITHM, key, iv);

    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag();

    return JSON.stringify({
      iv: iv.toString('hex'),
      authTag: authTag.toString('hex'),
      encrypted,
    });
  }

  /**
   * Decrypt a value
   */
  static decrypt(encryptedValue: string): string {
    try {
      const { iv, authTag, encrypted } = JSON.parse(encryptedValue);
      const key = crypto.scryptSync(Configuration.ENCRYPTION_KEY, 'salt', 32);
      const decipher = crypto.createDecipheriv(
        Configuration.ENCRYPTION_ALGORITHM,
        key,
        Buffer.from(iv, 'hex'),
      );

      decipher.setAuthTag(Buffer.from(authTag, 'hex'));

      let decrypted = decipher.update(encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');

      return decrypted;
    } catch {
      return encryptedValue; // Return as-is if decryption fails
    }
  }

  /**
   * Get typed value
   */
  getTypedValue<T = unknown>(): T {
    const rawValue = this.isSecret ? Configuration.decrypt(this.value) : this.value;

    switch (this.valueType) {
      case ConfigValueType.NUMBER:
        return Number(rawValue) as T;
      case ConfigValueType.BOOLEAN:
        return (rawValue === 'true' || rawValue === '1') as T;
      case ConfigValueType.JSON:
        return JSON.parse(rawValue) as T;
      default:
        return rawValue as T;
    }
  }
}

/**
 * Configuration History Entity
 * Tracks all changes for audit purposes
 */
@Entity('configuration_history')
@Index(['configurationId', 'changedAt'])
@Index(['tenantId', 'changedAt'])
@ObjectType()
export class ConfigurationHistory {
  @PrimaryGeneratedColumn('uuid')
  @Field(() => ID)
  id!: string;

  @Column('uuid')
  @Index()
  @Field()
  configurationId!: string;

  @Column({ length: 100 })
  @Field()
  tenantId!: string;

  @Column({ length: 100 })
  @Field()
  service!: string;

  @Column({ length: 255 })
  @Field()
  key!: string;

  @Column('text')
  @Field()
  previousValue!: string;

  @Column('text')
  @Field()
  newValue!: string;

  @Column({ length: 100 })
  @Field()
  changedBy!: string;

  @Column()
  @Field()
  changedAt!: Date;

  @Column({ length: 255, nullable: true })
  @Field({ nullable: true })
  changeReason?: string;
}
