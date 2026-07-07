import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { createEncryptedColumnTransformer } from '@aquaculture/backend-common/security';

export type AgentRole = 'operator' | 'manager' | 'expert' | 'supervisor';
export type ActuationPolicy = 'blocked' | 'confirm_required' | 'allowed';

/** Selectable LLM providers for BYOK. Kept in sync with LlmProviderId. */
export type LlmProviderId = 'anthropic' | 'openai';

/**
 * Env var holding the AES-256 key that encrypts tenant AI API keys at rest.
 * Dedicated to this domain (not shared with PII keys) so it can be rotated
 * independently. Required in production; the transformer hard-fails boot if
 * absent under NODE_ENV=production.
 */
const AI_SECRET_KEY_ENV = 'AI_TENANT_SECRET_ENCRYPTION_KEY';

@Entity('tenant_agent_configs')
@Index(['tenantId'], { unique: true })
export class TenantAgentConfig {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  tenantId!: string;

  // ── BYOK: per-tenant AI credentials (Faz 1) ──────────────────────────────
  // Provider the tenant has selected. Their key for THIS provider must be
  // present for AI to be enabled (see AgentConfigService.resolveCredential).
  @Column({ type: 'varchar', length: 20, default: 'anthropic' })
  provider!: LlmProviderId;

  // Keys are AES-256-GCM encrypted at rest via the platform transformer
  // (enc: prefix, authenticated). Stored as text; NEVER selected into a
  // response unmasked — the CRUD read path returns only a last-4 hint.
  @Column({
    type: 'text',
    nullable: true,
    transformer: createEncryptedColumnTransformer(AI_SECRET_KEY_ENV),
  })
  anthropicApiKey?: string | null;

  @Column({
    type: 'text',
    nullable: true,
    transformer: createEncryptedColumnTransformer(AI_SECRET_KEY_ENV),
  })
  openaiApiKey?: string | null;

  // Optional per-tenant chat model override. Null → the persona default
  // (resolved in AgentProfileService). Not the embedding model — that is a
  // platform-standard self-hosted model (Faz 3), never tenant-configurable.
  @Column({ type: 'varchar', length: 64, nullable: true })
  chatModel?: string | null;

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
