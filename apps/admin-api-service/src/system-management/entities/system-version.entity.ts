import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

export enum ReleaseType {
  MAJOR = 'major',
  MINOR = 'minor',
  PATCH = 'patch',
  HOTFIX = 'hotfix',
  SECURITY = 'security',
  BETA = 'beta',
  ALPHA = 'alpha',
}

export enum ReleaseStatus {
  DRAFT = 'draft',
  STAGED = 'staged',
  DEPLOYING = 'deploying',
  DEPLOYED = 'deployed',
  ROLLED_BACK = 'rolled_back',
  DEPRECATED = 'deprecated',
}

export interface ChangelogEntry {
  type: 'feature' | 'improvement' | 'bugfix' | 'security' | 'breaking' | 'deprecated';
  title: string;
  description: string;
  ticketId?: string;
  pullRequestId?: string;
  affectedModules?: string[];
}

export interface MigrationInfo {
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  executedAt?: Date;
  duration?: number;
  error?: string;
}

@Entity('system_versions')
@Index(['version'], { unique: true })
@Index(['releaseType', 'status'])
@Index(['deployedAt'])
export class SystemVersion {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ length: 50 })
  version!: string;

  @Column({ type: 'int' })
  majorVersion!: number;

  @Column({ type: 'int' })
  minorVersion!: number;

  @Column({ type: 'int' })
  patchVersion!: number;

  @Column({ type: 'varchar', length: 50, nullable: true })
  preReleaseTag?: string;

  @Column({ type: 'varchar', length: 50, default: ReleaseType.PATCH })
  releaseType!: ReleaseType;

  @Column({ type: 'varchar', length: 50, default: ReleaseStatus.DRAFT })
  status!: ReleaseStatus;

  @Column({ length: 255 })
  title!: string;

  @Column({ type: 'text', nullable: true })
  summary?: string;

  @Column({ type: 'jsonb', nullable: true })
  changelog?: ChangelogEntry[];

  @Column({ type: 'jsonb', nullable: true })
  migrations?: MigrationInfo[];

  @Column({ type: 'jsonb', nullable: true })
  breakingChanges?: string[];

  @Column({ type: 'jsonb', nullable: true })
  deprecations?: string[];

  @Column({ type: 'jsonb', nullable: true })
  newFeatures?: string[];

  @Column({ type: 'jsonb', nullable: true })
  dependencies?: Record<string, string>;

  @Column({ type: 'text', nullable: true })
  releaseNotes?: string;

  @Column({ type: 'text', nullable: true })
  upgradeGuide?: string;

  @Column({ nullable: true })
  deployedAt?: Date;

  @Column({ nullable: true })
  deployedBy?: string;

  @Column({ type: 'int', nullable: true })
  deploymentDurationSeconds?: number;

  @Column({ type: 'jsonb', nullable: true })
  deploymentEnvironments?: Array<{
    name: string;
    deployedAt: Date;
    status: string;
  }>;

  @Column({ default: false })
  isCurrentVersion!: boolean;

  @Column({ type: 'text', nullable: true })
  previousVersion?: string;

  @Column({ type: 'jsonb', nullable: true })
  rollbackInfo?: {
    rolledBackAt?: Date;
    rolledBackBy?: string;
    reason?: string;
    targetVersion?: string;
  };

  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, unknown>;

  @Column({ nullable: true })
  createdBy?: string;

  @CreateDateColumn()
  createdAt!: Date;
}
