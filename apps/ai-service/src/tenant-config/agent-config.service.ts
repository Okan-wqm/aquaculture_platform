import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import {
  runInTenantRead,
  runInTenantTransaction,
} from '@aquaculture/backend-common/database';
import { TenantAgentConfig, LlmProviderId } from './agent-config.entity';
import { LlmCredential } from '../agent/providers/llm-provider.interface';

/** Default config used when tenant has no specific configuration */
const DEFAULT_CONFIG: Partial<TenantAgentConfig> = {
  baseProfileId: 'operator-v1',
  additionalToolNames: [],
  blockedToolNames: [],
  actuationPolicy: 'confirm_required',
  applicableRoles: ['operator'],
  isEnabled: true,
  proactiveMonitoringEnabled: false,
  // FARM-AI Sprint 1.2: routine orchestrator opt-in — OFF until the tenant
  // turns it on (first reader is the Faz-5 routine orchestrator).
  routineAiEnabled: false,
  autonomousActionsEnabled: false,
  monthlyTokenBudget: 1_000_000,
  hourlyRequestLimit: 60,
  mcpEnabled: false,
  mcpAllowedPersonas: [],
  provider: 'anthropic',
  anthropicApiKey: null,
  openaiApiKey: null,
  zaiApiKey: null,
  chatModel: null,
};

/**
 * A tenant's resolved AI enablement. `enabled` is the fail-closed truth used by
 * the agent runner: AI runs ONLY when the tenant switch is on AND a key exists
 * for the selected provider. `reason` lets the UI show the right prompt.
 */
export interface AiEnablement {
  enabled: boolean;
  reason: 'ok' | 'disabled' | 'key_missing';
  provider: LlmProviderId;
}

@Injectable()
export class AgentConfigService {
  private readonly logger = new Logger(AgentConfigService.name);

  constructor(
    @InjectRepository(TenantAgentConfig)
    private readonly configRepo: Repository<TenantAgentConfig>,
    private readonly dataSource: DataSource,
  ) {}

  async getConfig(tenantId: string): Promise<TenantAgentConfig> {
    // Tenant-schema-pinned read (MSGFIX: the NATS responders had no pin and
    // read the service-default schema — saved BYOK keys were invisible there,
    // every enablement check fell back to DEFAULT_CONFIG/key_missing). HTTP
    // callers already carry the same pin via TenantSchemaMiddleware; nesting
    // the identical pin is idempotent.
    const config = await runInTenantRead(
      this.dataSource,
      'ai',
      tenantId,
      async (queryRunner) =>
        queryRunner.manager.findOne(TenantAgentConfig, { where: { tenantId } }),
    ).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Tenant-pinned config read failed for ${tenantId}: ${msg}`);
      return null;
    });
    if (config) return config;

    // Return default config if none exists
    this.logger.debug(`No AI config for tenant ${tenantId}, using defaults`);
    return { ...DEFAULT_CONFIG, tenantId } as TenantAgentConfig;
  }

  async upsertConfig(
    tenantId: string,
    updates: Partial<TenantAgentConfig>,
  ): Promise<TenantAgentConfig> {
    // Tenant-pinned write (MSGFIX: same NATS/HTTP parity as getConfig — the
    // row belongs to the tenant schema on every path).
    return runInTenantTransaction(
      this.dataSource,
      'ai',
      tenantId,
      async (queryRunner) => {
        const manager = queryRunner.manager;
        const existing = await manager.findOne(TenantAgentConfig, {
          where: { tenantId },
        });
        if (existing) {
          Object.assign(existing, updates);
          return manager.save(TenantAgentConfig, existing);
        }
        const config = manager.create(TenantAgentConfig, {
          ...DEFAULT_CONFIG,
          ...updates,
          tenantId,
        });
        return manager.save(TenantAgentConfig, config);
      },
    );
  }

  /**
   * FAZ1-BYOK: the single fail-closed enablement check.
   *
   * AI is enabled iff the tenant switch is on AND the selected provider has a
   * stored key. A key-less-but-switched-on tenant is NOT enabled — this is the
   * "key yoksa AI kapalı" product decision, enforced here rather than trusting
   * the boolean flag alone. Callers map `key_missing` to the AI_KEY_MISSING
   * user contract so the UI can prompt for a key.
   */
  async resolveEnablement(tenantId: string): Promise<AiEnablement> {
    const config = await this.getConfig(tenantId);
    const provider = config.provider ?? 'anthropic';

    if (!config.isEnabled) {
      return { enabled: false, reason: 'disabled', provider };
    }

    const key = this.keyForProvider(config, provider);
    if (!key) {
      return { enabled: false, reason: 'key_missing', provider };
    }

    return { enabled: true, reason: 'ok', provider };
  }

  /**
   * Resolve the decrypted credential for the tenant's selected provider, or
   * null when no key is stored. The returned plaintext key is short-lived —
   * used for one request and never logged or persisted.
   */
  async resolveCredential(tenantId: string): Promise<LlmCredential | null> {
    const config = await this.getConfig(tenantId);
    const provider = config.provider ?? 'anthropic';
    const apiKey = this.keyForProvider(config, provider);
    return apiKey ? { provider, apiKey } : null;
  }

  /**
   * Back-compat shim retained for existing callers that only need the boolean.
   * Now delegates to the fail-closed enablement so a key-less tenant reads as
   * disabled everywhere, not just in the runner.
   */
  async isEnabled(tenantId: string): Promise<boolean> {
    return (await this.resolveEnablement(tenantId)).enabled;
  }

  private keyForProvider(
    config: TenantAgentConfig,
    provider: LlmProviderId,
  ): string | null {
    const raw =
      provider === 'openai'
        ? config.openaiApiKey
        : provider === 'zai'
          ? config.zaiApiKey
          : config.anthropicApiKey;
    const trimmed = raw?.trim();
    return trimmed ? trimmed : null;
  }
}
