import {
  Body,
  Controller,
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
import { Request } from 'express';
import { Roles, Role } from '@aquaculture/backend-common/decorators';
import { JwtAuthGuard } from '../chat/guards/jwt-auth.guard';
import { AgentConfigService } from './agent-config.service';
import { LlmProviderId } from './agent-config.entity';
import { LlmProviderFactory } from '../agent/providers/llm-provider.factory';

interface TenantRequest extends Request {
  tenantId?: string;
  user?: { sub?: string; tenantId?: string; roles?: string[] };
}

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
  @Roles(Role.TENANT_ADMIN)
  async getSettings(@Req() req: TenantRequest): Promise<AiSettingsView> {
    const tenantId = this.requireTenant(req);
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
  @Roles(Role.TENANT_ADMIN)
  async updateSettings(
    @Req() req: TenantRequest,
    @Body() body: UpdateAiSettingsDto,
  ): Promise<AiSettingsView> {
    const tenantId = this.requireTenant(req);

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
    return this.getSettings(req);
  }

  /**
   * Turn a submitted key value into the persisted value: empty → null (clear);
   * non-empty → the key, but only after a live validation ping succeeds. A
   * rejected key throws (400 via provider factory / UnauthorizedException) so
   * the dead key is never written.
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
      throw new UnauthorizedException(
        'A masked key hint cannot be submitted as a key. Enter the full key or leave it unchanged.',
      );
    }

    const providerImpl = this.providerFactory.get(provider);
    const valid = await providerImpl.validateCredential({
      provider,
      apiKey: trimmed,
    });
    if (!valid) {
      throw new UnauthorizedException(
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
}
