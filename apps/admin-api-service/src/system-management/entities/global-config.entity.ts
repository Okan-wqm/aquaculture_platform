import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export enum ConfigCategory {
  API = 'api',
  DATABASE = 'database',
  CACHE = 'cache',
  SECURITY = 'security',
  EMAIL = 'email',
  STORAGE = 'storage',
  INTEGRATION = 'integration',
  NOTIFICATION = 'notification',
  PERFORMANCE = 'performance',
  FEATURE = 'feature',
  SYSTEM = 'system',
}

export enum ConfigValueType {
  STRING = 'string',
  NUMBER = 'number',
  BOOLEAN = 'boolean',
  JSON = 'json',
  ARRAY = 'array',
  SECRET = 'secret',
  URL = 'url',
  EMAIL = 'email',
  DURATION = 'duration',
}

export interface ConfigValidation {
  required?: boolean;
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  allowedValues?: unknown[];
  customValidator?: string;
}

export interface ConfigHistory {
  previousValue: unknown;
  newValue: unknown;
  changedAt: Date;
  changedBy: string;
  reason?: string;
}

@Entity('global_configs')
@Index(['key'], { unique: true })
@Index(['category'])
@Index(['isSecret'])
export class GlobalConfig {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ length: 200 })
  key: string;

  @Column({ length: 255 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string;

  @Column({ type: 'varchar', length: 50, default: ConfigCategory.SYSTEM })
  category: ConfigCategory;

  @Column({ type: 'varchar', length: 50, default: ConfigValueType.STRING })
  valueType: ConfigValueType;

  @Column({ type: 'jsonb' })
  value: unknown;

  @Column({ type: 'jsonb', nullable: true })
  defaultValue: unknown;

  @Column({ type: 'jsonb', nullable: true })
  validation: ConfigValidation;

  @Column({ default: false })
  isSecret: boolean;

  @Column({ default: false })
  isReadOnly: boolean;

  @Column({ default: false })
  requiresRestart: boolean;

  @Column({ default: false })
  isEnvironmentSpecific: boolean;

  @Column({ type: 'jsonb', nullable: true })
  environmentOverrides: Record<string, unknown>;

  @Column({ type: 'jsonb', nullable: true })
  history: ConfigHistory[];

  @Column({ type: 'int', default: 10 })
  maxHistoryEntries: number;

  @Column({ type: 'jsonb', nullable: true })
  dependsOn: string[];

  @Column({ type: 'jsonb', nullable: true })
  affectedServices: string[];

  @Column({ type: 'text', nullable: true })
  helpText: string;

  @Column({ type: 'text', nullable: true })
  warningMessage: string;

  @Column({ type: 'int', default: 0 })
  sortOrder: number;

  @Column({ nullable: true })
  lastModifiedBy: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
