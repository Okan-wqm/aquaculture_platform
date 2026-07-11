/**
 * @module AiResolver
 * @description GraphQL resolver for AI-powered messaging features.
 * Exposes sentiment trends (TENANT_ADMIN only), semantic similarity search,
 * AI privacy settings, and human-in-the-loop action confirmation.
 *
 * All queries respect channel membership and privacy gates.
 *
 * @see ADR-012 sections 12.1-12.5 (AI Integration Architecture)
 */
import {
  Resolver,
  Query,
  Mutation,
  Args,
  ID,
  Int,
  Float,
  ObjectType,
  Field,
} from '@nestjs/graphql';
import { UseGuards, Logger } from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';
import { Tenant, CurrentUser, CurrentUserPayload, Roles, Role } from '@aquaculture/backend-common/decorators';
import { TenantGuard } from '@aquaculture/backend-common/guards';

import { Message } from '../../message/entities/message.entity';

// DTOs
import { SentimentTrendsInput, SimilarMessagesInput } from '../dto/ai-channel.input';

// Queries
import { GetSentimentTrendsQuery } from '../queries/get-sentiment-trends.query';
import { SearchSimilarMessagesQuery } from '../queries/search-similar-messages.query';
import type { SentimentTrend } from '../queries/get-sentiment-trends.handler';
import type { SimilarMessage } from '../queries/search-similar-messages.handler';

// Services
import { AiPrivacyService } from '../services/ai-privacy.service';
import { AiChatBridgeService } from '../services/ai-chat-bridge.service';
import { AiPersonasRegistryService } from '../services/ai-personas-registry.service';

// ============================================================================
// GRAPHQL TYPES
// ============================================================================

/**
 * Weekly sentiment trend for a channel.
 */
@ObjectType()
export class SentimentTrendType {
  @Field(() => ID)
  channelId!: string;

  @Field()
  channelName!: string;

  @Field()
  weekStart!: string;

  @Field(() => Float)
  avgScore!: number;

  @Field(() => Int)
  messageCount!: number;

  @Field()
  trend!: string;
}

/**
 * Message with similarity score from vector search.
 */
@ObjectType()
export class SimilarMessageType {
  @Field(() => Message)
  message!: Message;

  @Field(() => Float)
  similarity!: number;
}

/**
 * Current AI settings for the tenant and user.
 */
@ObjectType()
export class AiSettingsType {
  @Field(() => Boolean, { description: 'Tenant-level AI analysis master switch' })
  tenantAiEnabled!: boolean;

  @Field(() => Boolean, { description: 'User-level AI analysis consent' })
  userAiConsent!: boolean;
}

/**
 * AI persona definition exposed via GraphQL.
 * @see ADR-012 Phase 4 (AI Persona-Based Messaging Channels)
 */
@ObjectType()
export class AiPersonaType {
  @Field(() => String, { nullable: true, description: 'Persona ID (null = general assistant)' })
  id!: string | null;

  @Field(() => String, { description: 'Human-readable display name' })
  name!: string;

  @Field(() => String, { description: 'Short description of persona specialization' })
  description!: string;

  @Field(() => String, { description: 'Icon identifier (Lucide icon name)' })
  icon!: string;

  @Field(() => String, { description: 'Theme color key for UI styling' })
  color!: string;

  @Field(() => [String], { description: 'List of capability labels' })
  capabilities!: string[];
}

// ============================================================================
// RESOLVER
// ============================================================================

@Resolver()
@UseGuards(TenantGuard)
export class AiResolver {
  private readonly logger = new Logger(AiResolver.name);

  constructor(
    private readonly queryBus: QueryBus,
    private readonly privacyService: AiPrivacyService,
    private readonly chatBridgeService: AiChatBridgeService,
    private readonly personasRegistry: AiPersonasRegistryService,
  ) {}

  // -------------------------------------------------------------------------
  // QUERIES
  // -------------------------------------------------------------------------

  /**
   * List available AI personas for the current tenant.
   * Returns all enabled personas with their metadata for the persona picker UI.
   * @see ADR-012 Phase 4 (AI Persona-Based Messaging Channels)
   */
  @Query(() => [AiPersonaType], {
    name: 'availableAiPersonas',
    description: 'List AI personas available for the current tenant',
  })
  @Roles(Role.MODULE_USER)
  async availableAiPersonas(
    @Tenant() tenantId: string,
  ): Promise<AiPersonaType[]> {
    return this.personasRegistry.getAvailablePersonas(tenantId);
  }

  /**
   * Get weekly aggregate sentiment trends per channel.
   * Only accessible to TENANT_ADMIN -- sentiment is never exposed per-message.
   */
  @Query(() => [SentimentTrendType], {
    name: 'sentimentTrends',
    description: 'Weekly aggregate sentiment trends per channel (TENANT_ADMIN only)',
  })
  @Roles(Role.TENANT_ADMIN)
  async sentimentTrends(
    @Args('input') input: SentimentTrendsInput,
    @Tenant() tenantId: string,
  ): Promise<SentimentTrend[]> {
    return this.queryBus.execute(
      new GetSentimentTrendsQuery(
        tenantId,
        input.channelId ?? null,
        input.weeks,
      ),
    );
  }

  /**
   * Search for semantically similar messages using vector embeddings.
   * Results are scoped to the requesting user's channels.
   */
  @Query(() => [SimilarMessageType], {
    name: 'similarMessages',
    description: 'Semantic similarity search across messages',
  })
  @Roles(Role.MODULE_USER)
  async similarMessages(
    @Args('input') input: SimilarMessagesInput,
    @CurrentUser() user: CurrentUserPayload,
    @Tenant() tenantId: string,
  ): Promise<SimilarMessage[]> {
    return this.queryBus.execute(
      new SearchSimilarMessagesQuery(
        tenantId,
        user.sub,
        input.query,
        input.channelId ?? null,
        input.limit,
      ),
    );
  }

  /**
   * Get current AI settings for the tenant and user.
   * Returns both tenant-level enable flag and user-level consent status.
   */
  @Query(() => AiSettingsType, {
    name: 'aiSettings',
    description: 'Current AI analysis settings for tenant and user',
  })
  @Roles(Role.MODULE_USER)
  async aiSettings(
    @CurrentUser() user: CurrentUserPayload,
    @Tenant() tenantId: string,
  ): Promise<AiSettingsType> {
    const [tenantAiEnabled, userAiConsent] = await Promise.all([
      this.privacyService.isTenantAiEnabled(tenantId),
      this.privacyService.hasUserConsented(tenantId, user.sub),
    ]);

    return { tenantAiEnabled, userAiConsent };
  }

  // -------------------------------------------------------------------------
  // MUTATIONS
  // -------------------------------------------------------------------------

  // updateTenantAiSetting removed — the tenant-level "AI on/off" master switch
  // is owned by ai-service (updateAiProviderSettings.isEnabled, where the tenant
  // also sets the provider key). Messaging no longer stores a duplicate flag;
  // the aiSettings query's tenantAiEnabled now reflects ai-service's SSoT.

  /**
   * Update user-level AI analysis consent.
   * Each user controls their own opt-in status.
   */
  @Mutation(() => Boolean, {
    name: 'updateUserAiConsent',
    description: 'Update user AI analysis consent',
  })
  @Roles(Role.MODULE_USER)
  async updateUserAiConsent(
    @Args('consent', { type: () => Boolean }) consent: boolean,
    @CurrentUser() user: CurrentUserPayload,
    @Tenant() tenantId: string,
  ): Promise<boolean> {
    await this.privacyService.setUserAiConsent(tenantId, user.sub, consent);
    return true;
  }

  /**
   * Confirm a proposed AI action (human-in-the-loop pattern).
   * Validates the action exists and is in 'proposed' state, then
   * executes it via the appropriate service.
   */
  @Mutation(() => Boolean, {
    name: 'confirmAiAction',
    description: 'Confirm and execute a proposed AI action',
  })
  @Roles(Role.MODULE_USER)
  async confirmAiAction(
    @Args('actionId', { type: () => ID }) actionId: string,
    @CurrentUser() user: CurrentUserPayload,
    @Tenant() tenantId: string,
  ): Promise<boolean> {
    return this.chatBridgeService.confirmAiAction(tenantId, actionId, user.sub);
  }
}
