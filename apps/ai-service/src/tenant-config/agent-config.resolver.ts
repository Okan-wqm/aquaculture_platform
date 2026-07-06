import { Logger, ForbiddenException, BadRequestException } from '@nestjs/common';
import {
  Resolver,
  Query,
  Mutation,
  Args,
  ObjectType,
  Field,
  InputType,
  Int,
  Context,
} from '@nestjs/graphql';
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
import {
  hasResourcePermission,
  type ResourcePermissionUser,
} from '@aquaculture/backend-common/decorators';
import { AgentConfigService } from './agent-config.service';
import { LlmProviderId } from './agent-config.entity';
import { LlmProviderFactory } from '../agent/providers/llm-provider.factory';

/**
 * Tenant AI settings (Faz 1 BYOK) exposed as a federated GraphQL subgraph
 * surface — consistent with every other platform service (no hand-rolled REST
 * proxy). Reads NEVER return a raw key, only a last-4 hint. Writes validate a
 * newly-supplied key against the live provider before persisting. The tenant is
 * resolved from the HMAC-verified assertion context (never from arguments), so
 * one admin cannot write another tenant's settings. Tenant-RBAC (Faz 7c):
 * `ai_settings:view` reads, `ai_settings:manage` writes — admins bypass.
 */
@ObjectType()
export class AiSettings {
  // GraphQL cannot infer a TS string-union type — declare it as String explicitly
  // (bare @Field() emits an "Undefined type" SDL error on the union types).
  @Field(() => String)
  provider!: LlmProviderId;

  @Field()
  isEnabled!: boolean;

  @Field(() => String)
  enablementReason!: 'ok' | 'disabled' | 'key_missing';

  @Field(() => String, { nullable: true })
  anthropicKeyHint!: string | null;

  @Field(() => String, { nullable: true })
  openaiKeyHint!: string | null;

  @Field(() => String, { nullable: true })
  chatModel!: string | null;

  @Field(() => Int)
  monthlyTokenBudget!: number;

  @Field(() => Int)
  hourlyRequestLimit!: number;

  @Field(() => [String])
  availableProviders!: LlmProviderId[];
}

@InputType()
export class UpdateAiSettingsInput {
  @IsOptional()
  @IsIn(['anthropic', 'openai'])
  @Field(() => String, { nullable: true })
  provider?: LlmProviderId;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Field(() => String, { nullable: true })
  anthropicApiKey?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Field(() => String, { nullable: true })
  openaiApiKey?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Field(() => String, { nullable: true })
  chatModel?: string;

  @IsOptional()
  @IsBoolean()
  @Field({ nullable: true })
  isEnabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000_000)
  @Field(() => Int, { nullable: true })
  monthlyTokenBudget?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100_000)
  @Field(() => Int, { nullable: true })
  hourlyRequestLimit?: number;
}

/** Minimal shape the federation context exposes for tenant + caller identity. */
interface GqlContext {
  req?: {
    tenantId?: string;
    user?: ResourcePermissionUser & { tenantId?: string };
  };
}

@Resolver(() => AiSettings)
export class AgentConfigResolver {
  private readonly logger = new Logger(AgentConfigResolver.name);

  constructor(
    private readonly agentConfig: AgentConfigService,
    private readonly providerFactory: LlmProviderFactory,
  ) {}

  // Named aiProviderSettings (not aiSettings) — the messaging subgraph already
  // owns Query.aiSettings for channel-level AI persona/consent; this is the
  // distinct tenant BYOK provider config, so the two federate without collision.
  @Query(() => AiSettings, {
    name: 'aiProviderSettings',
    description: "The tenant's AI provider (BYOK) settings, keys masked",
  })
  async aiProviderSettings(@Context() ctx: GqlContext): Promise<AiSettings> {
    const { tenantId, user } = this.requireContext(ctx);
    // Faz 7c: reading masked settings needs ai_settings:view (admins bypass).
    this.assertCapability(user, 'ai_settings:view');
    return this.buildView(tenantId);
  }

  @Mutation(() => AiSettings, {
    name: 'updateAiProviderSettings',
    description: "Update the tenant's AI provider (BYOK) settings",
  })
  async updateAiProviderSettings(
    @Args('input') input: UpdateAiSettingsInput,
    @Context() ctx: GqlContext,
  ): Promise<AiSettings> {
    const { tenantId, user } = this.requireContext(ctx);
    // Faz 7c: writing settings — incl. the BYOK keys — needs ai_settings:manage.
    this.assertCapability(user, 'ai_settings:manage');

    const updates: Parameters<AgentConfigService['upsertConfig']>[1] = {};
    if (input.provider !== undefined) updates.provider = input.provider;
    if (input.chatModel !== undefined) {
      updates.chatModel = input.chatModel.trim() || null;
    }
    if (input.isEnabled !== undefined) updates.isEnabled = input.isEnabled;
    if (input.monthlyTokenBudget !== undefined) {
      updates.monthlyTokenBudget = input.monthlyTokenBudget;
    }
    if (input.hourlyRequestLimit !== undefined) {
      updates.hourlyRequestLimit = input.hourlyRequestLimit;
    }
    if (input.anthropicApiKey !== undefined) {
      updates.anthropicApiKey = await this.resolveKeyUpdate('anthropic', input.anthropicApiKey);
    }
    if (input.openaiApiKey !== undefined) {
      updates.openaiApiKey = await this.resolveKeyUpdate('openai', input.openaiApiKey);
    }

    await this.agentConfig.upsertConfig(tenantId, updates);
    this.logger.log(`AI settings updated for tenant ${tenantId}`);
    return this.buildView(tenantId);
  }

  /** Build the masked settings view. No auth — callers gate before invoking. */
  private async buildView(tenantId: string): Promise<AiSettings> {
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

  /**
   * Turn a submitted key into the persisted value: empty → null (clear);
   * non-empty → the key, only after a live validation ping. Every rejection is a
   * 400-class GraphQL error (bad user input), never a masked hint round-trip.
   */
  private async resolveKeyUpdate(
    provider: LlmProviderId,
    submitted: string,
  ): Promise<string | null> {
    const trimmed = submitted.trim();
    if (!trimmed) return null;
    if (trimmed.includes('•')) {
      throw new BadRequestException(
        'A masked key hint cannot be submitted as a key. Enter the full key or leave it unchanged.',
      );
    }
    if (!this.providerFactory.supports(provider)) {
      throw new BadRequestException(
        `The "${provider}" AI provider is not available yet. Available: ${this.providerFactory
          .availableProviders()
          .join(', ')}.`,
      );
    }
    const impl = this.providerFactory.get(provider);
    const valid = await impl.validateCredential({ provider, apiKey: trimmed });
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
    return `••••${trimmed.slice(-4)}`;
  }

  private assertCapability(user: ResourcePermissionUser, capability: string): void {
    if (!hasResourcePermission(user, capability)) {
      throw new ForbiddenException(`Missing required permission: ${capability}`);
    }
  }

  private requireContext(ctx: GqlContext): {
    tenantId: string;
    user: ResourcePermissionUser;
  } {
    const req = ctx.req;
    const tenantId = req?.tenantId ?? req?.user?.tenantId;
    const user = req?.user;
    if (!tenantId || !user) {
      throw new ForbiddenException('Tenant context required');
    }
    return { tenantId, user };
  }
}
