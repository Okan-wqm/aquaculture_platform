import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export type AgentRole = 'operator' | 'manager' | 'expert' | 'supervisor';
export type ActuationPolicy = 'blocked' | 'confirm_required' | 'allowed';

@Entity('tenant_agent_configs', { schema: 'ai' })
@Index(['tenantId'], { unique: true })
export class TenantAgentConfig {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  tenantId!: string;

  @Column({ type: 'varchar', length: 50, default: 'operator-v1' })
  baseProfileId!: string;

  @Column({ type: 'jsonb', default: '[]' })
  additionalToolNames!: string[];

  @Column({ type: 'jsonb', default: '[]' })
  blockedToolNames!: string[];

  @Column({ type: 'varchar', length: 50, default: 'confirm_required' })
  actuationPolicy!: ActuationPolicy;

  @Column({ type: 'text', nullable: true })
  customSystemPrompt?: string;

  @Column({ type: 'jsonb', default: '["operator"]' })
  applicableRoles!: AgentRole[];

  @Column({ type: 'boolean', default: true })
  isEnabled!: boolean;

  // Proactive monitoring
  @Column({ type: 'boolean', default: false })
  proactiveMonitoringEnabled!: boolean;

  @Column({ type: 'boolean', default: false })
  autonomousActionsEnabled!: boolean;

  @Column({ type: 'jsonb', nullable: true })
  autonomousSafetyLimits?: {
    maxDosingKg?: number;
    phRange?: { min: number; max: number };
    temperatureRange?: { min: number; max: number };
  };

  // Cost control
  @Column({ type: 'int', default: 1000000 })
  monthlyTokenBudget!: number;

  @Column({ type: 'int', default: 60 })
  hourlyRequestLimit!: number;

  // MCP
  @Column({ type: 'boolean', default: false })
  mcpEnabled!: boolean;

  @Column({ type: 'jsonb', default: '[]' })
  mcpAllowedPersonas!: string[];

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
