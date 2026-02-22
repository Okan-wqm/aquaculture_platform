import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TenantAgentConfig } from './agent-config.entity';

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
};

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

  async isEnabled(tenantId: string): Promise<boolean> {
    const config = await this.getConfig(tenantId);
    return config.isEnabled;
  }
}
