import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Logger,
  Put,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { hasResourcePermission } from '@aquaculture/backend-common/decorators';
import type { TenantRequest } from '@aquaculture/backend-common/types';
import { JwtAuthGuard } from '../chat/guards/jwt-auth.guard';
import { AgentConfigService } from './agent-config.service';
import { LlmProviderId } from './agent-config.entity';
import { LlmProviderFactory } from '../agent/providers/llm-provider.factory';

/**
 * Update payload for a tenant's AI settings.
 *
 * Key semantics (write-only, never echoed): a non-empty string SETS the key
 * (validated live before persisting); an empty string CLEARS it; `undefined`
 * (field omitted) leaves the stored key untouched. A masked "•••• last4" hint
 * that a GET returns is rejected on write so a round-tripped hint can never be
 * mistaken for a real key.
 */
class UpdateAiSettingsDto {
  @IsOptional()
  @IsIn(['anthropic', 'openai'])
  provider?: LlmProviderId;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  anthropicApiKey?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  openaiApiKey?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  chatModel?: string;

  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000_000)
  monthlyTokenBudget?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100_000)
  hourlyRequestLimit?: number;
}

interface AiSettingsView {
  provider: LlmProviderId;
  isEnabled: boolean;
  enablementReason: 'ok' | 'disabled' | 'key_missing';
  anthropicKeyHint: string | null;
  openaiKeyHint: string | null;
  chatModel: string | null;
  monthlyTokenBudget: number;
  hourlyRequestLimit: number;
  availableProviders: LlmProviderId[];
}

/**
 * Tenant AI settings CRUD (Faz 1 BYOK).
 *
 * TENANT_ADMIN only. Reads NEVER return a raw key — only a last-4 hint. Writes
 * validate a newly-supplied key against the live provider before persisting, so
 * a tenant cannot save a dead key and then wonder why AI is silently off. The
 * tenant is resolved from the verified request context (never from the body),
 * so one admin cannot write another tenant's settings.
 */
@UseGuards(JwtAuthGuard)
@Controller('api/v2/ai/settings')
export class AgentConfigController {
  private readonly logger = new Logger(AgentConfigController.name);

  constructor(
    private readonly agentConfig: AgentConfigService,
    private readonly providerFactory: LlmProviderFactory,
  ) {}

  @Get()
  async getSettings(@Req() req: TenantRequest): Promise<AiSettingsView> {
    const tenantId = this.requireTenant(req);
    // Tenant-RBAC (Faz 7c): reading AI settings (masked hints, provider, budget)
    // needs ai_settings:view. Admins bypass; a tenant can delegate to any role.
    this.assertCapability(req, 'ai_settings:view');
    return this.buildView(tenantId);
  }

  /** Build the masked settings view. No auth — callers gate before invoking. */
  private async buildView(tenantId: string): Promise<AiSettingsView> {
    const config = await this.agentConfig.getConfig(tenantId);
    const enablement = await this.agentConfig.resolveEnablement(tenantId);

    return {
      provider: config.provider ?? 'anthropic',
      isEnabled: enablement.enabled,
      enablementReason: enablement.reason,
      anthropicKeyHint: this.hint(config.anthropicApiKey),
      openaiKeyHint: this.hint(config.openaiApiKey),
      chatModel: config.chatModel ?? null,
      monthlyTokenBudget: config.monthlyTokenBudget,
      hourlyRequestLimit: config.hourlyRequestLimit,
      availableProviders: this.providerFactory.availableProviders(),
    };
  }

  @Put()
  async updateSettings(
    @Req() req: TenantRequest,
    @Body() body: UpdateAiSettingsDto,
  ): Promise<AiSettingsView> {
    const tenantId = this.requireTenant(req);
    // Tenant-RBAC (Faz 7c): writing AI settings — including the BYOK keys — needs
    // ai_settings:manage. Admins bypass; by default only the Supervisor role
    // carries this grant (a tenant admin can widen/narrow it in the role editor).
    this.assertCapability(req, 'ai_settings:manage');

    const updates: Parameters<AgentConfigService['upsertConfig']>[1] = {};
    if (body.provider !== undefined) updates.provider = body.provider;
    if (body.chatModel !== undefined) {
      updates.chatModel = body.chatModel.trim() || null;
    }
    if (body.isEnabled !== undefined) updates.isEnabled = body.isEnabled;
    if (body.monthlyTokenBudget !== undefined) {
      updates.monthlyTokenBudget = body.monthlyTokenBudget;
    }
    if (body.hourlyRequestLimit !== undefined) {
      updates.hourlyRequestLimit = body.hourlyRequestLimit;
    }

    // Keys: validate-before-persist. Clearing (empty string) needs no probe.
    if (body.anthropicApiKey !== undefined) {
      updates.anthropicApiKey = await this.resolveKeyUpdate(
        'anthropic',
        body.anthropicApiKey,
      );
    }
    if (body.openaiApiKey !== undefined) {
      updates.openaiApiKey = await this.resolveKeyUpdate(
        'openai',
        body.openaiApiKey,
      );
    }

    await this.agentConfig.upsertConfig(tenantId, updates);
    this.logger.log(`AI settings updated for tenant ${tenantId}`);
    // Read-back via buildView (not getSettings) — the caller already passed the
    // manage gate; re-asserting view here would 403 a manage-only grant.
    return this.buildView(tenantId);
  }

  /**
   * Turn a submitted key value into the persisted value: empty → null (clear);
   * non-empty → the key, but only after a live validation ping succeeds. Every
   * rejection is a 400 (request-content invalidity) — NOT 401: the caller is a
   * fully-authenticated TENANT_ADMIN, and SPA/mobile interceptors treat 401 as
   * session-expiry and would log the admin out mid-form. The dead key is never
   * written.
   */
  private async resolveKeyUpdate(
    provider: LlmProviderId,
    submitted: string,
  ): Promise<string | null> {
    const trimmed = submitted.trim();
    if (!trimmed) {
      return null;
    }
    // Reject an echoed masked hint (contains the mask bullet) as a real key.
    if (trimmed.includes('•')) {
      throw new BadRequestException(
        'A masked key hint cannot be submitted as a key. Enter the full key or leave it unchanged.',
      );
    }

    // The provider must be wired in this build. The DTO permits provider:'openai'
    // but OpenAiProvider is Faz 1b — submitting an OpenAI key now is a clean 400
    // (with the available providers), not a 500 from an unwired factory lookup.
    if (!this.providerFactory.supports(provider)) {
      throw new BadRequestException(
        `The "${provider}" AI provider is not available yet. Available: ${this.providerFactory
          .availableProviders()
          .join(', ')}.`,
      );
    }

    const providerImpl = this.providerFactory.get(provider);
    const valid = await providerImpl.validateCredential({
      provider,
      apiKey: trimmed,
    });
    if (!valid) {
      throw new BadRequestException(
        `The ${provider} API key was rejected by the provider. Check the key and try again.`,
      );
    }
    return trimmed;
  }

  /** Last-4 hint for a stored key, or null when unset. Never the full key. */
  private hint(key: string | null | undefined): string | null {
    const trimmed = key?.trim();
    if (!trimmed) return null;
    const last4 = trimmed.slice(-4);
    return `••••${last4}`;
  }

  private requireTenant(req: TenantRequest): string {
    const tenantId = req.tenantId ?? req.user?.tenantId;
    if (!tenantId) {
      throw new UnauthorizedException('Tenant context required');
    }
    return tenantId;
  }

  /**
   * Tenant-RBAC capability gate. Uses the shared SSoT check (admins bypass;
   * otherwise the capability must be in the user's resourcePermissions, threaded
   * to ai-service via the verified assertion — SEC-HIGH-054). Throws 403 on deny.
   * Programmatic (not @RequireTenantPermission) because ai-service does not
   * register TenantPermissionGuard globally — same shape as the messaging
   * createChannel gate, one SSoT.
   */
  private assertCapability(req: TenantRequest, capability: string): void {
    if (!hasResourcePermission(req.user, capability)) {
      throw new ForbiddenException(
        `Missing required permission: ${capability}`,
      );
    }
  }
}
