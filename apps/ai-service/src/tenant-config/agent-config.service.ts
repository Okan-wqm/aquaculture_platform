import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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
  autonomousActionsEnabled: false,
  monthlyTokenBudget: 1_000_000,
  hourlyRequestLimit: 60,
  mcpEnabled: false,
  mcpAllowedPersonas: [],
  provider: 'anthropic',
  anthropicApiKey: null,
  openaiApiKey: null,
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
  ) {}

  async getConfig(tenantId: string): Promise<TenantAgentConfig> {
    const config = await this.configRepo.findOne({ where: { tenantId } });
    if (config) return config;

    // Return default config if none exists
    this.logger.debug(`No AI config for tenant ${tenantId}, using defaults`);
    return { ...DEFAULT_CONFIG, tenantId } as TenantAgentConfig;
  }

  async upsertConfig(
    tenantId: string,
    updates: Partial<TenantAgentConfig>,
  ): Promise<TenantAgentConfig> {
    const existing = await this.configRepo.findOne({ where: { tenantId } });

    if (existing) {
      Object.assign(existing, updates);
      return this.configRepo.save(existing);
    }

    const config = this.configRepo.create({
      ...DEFAULT_CONFIG,
      ...updates,
      tenantId,
    });
    return this.configRepo.save(config);
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
      provider === 'openai' ? config.openaiApiKey : config.anthropicApiKey;
    const trimmed = raw?.trim();
    return trimmed ? trimmed : null;
  }
}
