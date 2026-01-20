import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export enum FeatureToggleScope {
  GLOBAL = 'global',
  TENANT = 'tenant',
  USER = 'user',
  ENVIRONMENT = 'environment',
}

export enum FeatureToggleStatus {
  ENABLED = 'enabled',
  DISABLED = 'disabled',
  PERCENTAGE_ROLLOUT = 'percentage_rollout',
  SCHEDULED = 'scheduled',
}

export interface FeatureCondition {
  type: 'tenant_id' | 'user_role' | 'plan_type' | 'region' | 'custom';
  operator: 'equals' | 'not_equals' | 'contains' | 'in' | 'not_in' | 'regex';
  value: string | string[];
}

export interface RolloutSchedule {
  startDate: Date;
  endDate?: Date;
  percentage: number;
  targetPercentage?: number;
  incrementPerDay?: number;
}

@Entity('feature_toggles')
@Index(['key'], { unique: true })
@Index(['scope', 'status'])
@Index(['category'])
export class FeatureToggle {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ length: 100 })
  key: string;

  @Column({ length: 255 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string;

  @Column({ type: 'varchar', length: 50, default: FeatureToggleScope.GLOBAL })
  scope: FeatureToggleScope;

  @Column({ type: 'varchar', length: 50, default: FeatureToggleStatus.DISABLED })
  status: FeatureToggleStatus;

  @Column({ length: 100, nullable: true })
  category: string;

  @Column({ type: 'jsonb', nullable: true })
  conditions: FeatureCondition[];

  @Column({ type: 'int', default: 0 })
  rolloutPercentage: number;

  @Column({ type: 'jsonb', nullable: true })
  rolloutSchedule: RolloutSchedule;

  @Column({ type: 'jsonb', nullable: true })
  enabledTenants: string[];

  @Column({ type: 'jsonb', nullable: true })
  disabledTenants: string[];

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown>;

  @Column({ type: 'jsonb', nullable: true })
  defaultValue: unknown;

  @Column({ type: 'jsonb', nullable: true })
  variants: Array<{
    key: string;
    value: unknown;
    weight: number;
    description?: string;
  }>;

  @Column({ default: false })
  requiresRestart: boolean;

  @Column({ default: false })
  isExperimental: boolean;

  @Column({ nullable: true })
  deprecatedAt: Date;

  @Column({ type: 'text', nullable: true })
  deprecationMessage: string;

  @Column({ nullable: true })
  createdBy: string;

  @Column({ nullable: true })
  updatedBy: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
