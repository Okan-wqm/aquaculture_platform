/**
 * @module AiModule
 * @description AI integration module for the messaging service. Provides
 * embedding generation, sentiment analysis, knowledge extraction, AI chat
 * bridging, and dual-consent privacy management.
 *
 * All AI features are opt-in and optional -- messaging works without them.
 * The module gracefully degrades when ai-service is unavailable.
 *
 * Imports ChannelModule and MessageModule for cross-references.
 * Exports AiPrivacyService for use by other modules.
 *
 * @see ADR-012 sections 12.1-12.5 (AI Integration Architecture)
 */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CqrsModule } from '@nestjs/cqrs';
import { ClientsModule } from '@nestjs/microservices';
import { NatsV3Client } from '@aquaculture/backend-common/nats';

// Feature module dependencies
import { ChannelModule } from '../channel/channel.module';
import { MessageModule } from '../message/message.module';
import { PresenceModule } from '../presence/presence.module';

// Entities
import { MessageAnalysis } from './entities/message-analysis.entity';
import { MessageEntityReference } from './entities/message-entity-reference.entity';
import { KnowledgeEntry } from './entities/knowledge-entry.entity';
import { UserAiConsent } from './entities/user-ai-consent.entity';
import { Message } from '../message/entities/message.entity';
import { Channel } from '../channel/entities/channel.entity';
// Services
import { AiEgressGateService } from './services/ai-egress-gate.service';
import { AiPrivacyService } from './services/ai-privacy.service';
import { AiCallerCapabilitiesService } from './services/ai-caller-capabilities.service';
import { KnowledgeExtractionService } from './services/knowledge-extraction.service';
import { AiChatBridgeService } from './services/ai-chat-bridge.service';
import { AiPersonasRegistryService } from './services/ai-personas-registry.service';
// MSGFIX-FAZ0: env-driven AI kill-switch (MESSAGING_AI_TRIGGER_ENABLED, default OFF).
// The Faz 2 trigger injects this before enqueuing any AI analysis.
import { AiTriggerConfig } from './ai-trigger.config';
// MSGFIX-FAZ2 2.2: durable MessageSent consumer that dispatches
// AnalyzeMessageCommand (the previously-missing trigger wire).
import { AiTriggerNatsHandler } from './ai-trigger-nats.handler';

// AI Safety — SSRF / input filter / output PII scanner now come from the
// shared core module (libs/backend-common/src/ai-safety) extracted under
// AUDIT-HIGH-007.
// MSGFIX-FAZ2 2.3: the service-local instruction-hierarchy +
// tool-schema-validator safety services were DELETED — their only consumer
// was the bridge's dead prompt-hardening ferry, and ai-service's
// AiSafetyMiddleware chain is the live, authoritative hardening. No prompt
// is computed (or ferried) on the messaging side anymore.
import { AiSafetyCoreModule } from '@aquaculture/backend-common/ai-safety';

// Command Handlers
import { AnalyzeMessageHandler } from './commands/analyze-message.handler';

// Query Handlers
import { GetSentimentTrendsHandler } from './queries/get-sentiment-trends.handler';
import { SearchSimilarMessagesHandler } from './queries/search-similar-messages.handler';

// Resolver
import { AiResolver } from './resolvers/ai.resolver';

const commandHandlers = [AnalyzeMessageHandler];

const queryHandlers = [GetSentimentTrendsHandler, SearchSimilarMessagesHandler];

const services = [
  AiPrivacyService,
  AiEgressGateService,
  // MSGFIX-FAZ2 2.3: auth-service caller-capability resolver (roles +
  // effective resourcePermissions, NATS + 60s Redis cache, fail-closed).
  AiCallerCapabilitiesService,
  KnowledgeExtractionService,
  AiChatBridgeService,
  AiPersonasRegistryService,
];

@Module({
  imports: [
    TypeOrmModule.forFeature([
      MessageAnalysis,
      MessageEntityReference,
      KnowledgeEntry,
      // ADR-015 follow-up: AI privacy consent tables registered for
      // repository injection in AiPrivacyService (replaces prior
      // raw-SQL queries that drifted on table + column names).
      UserAiConsent,
      Message,
      Channel,
    ]),
    CqrsModule,
    /** SEC-H01: NATS client with shared auth factory. */
    ClientsModule.register([
      {
        name: 'NATS_SERVICE',
        customClass: NatsV3Client,
        options: { serviceName: 'messaging-service' },
      },
    ]),
    // PresenceModule provides REDIS_CLIENT for AiPrivacyService
    PresenceModule,
    ChannelModule,
    MessageModule,
    // AI safety primitives extracted under AUDIT-HIGH-007.
    AiSafetyCoreModule,
  ],
  providers: [
    ...commandHandlers,
    ...queryHandlers,
    ...services,
    // MSGFIX-FAZ0: AI trigger kill-switch config (reads env once at boot,
    // logs one line when disabled). Exported for the Faz 2 trigger.
    AiTriggerConfig,
    // MSGFIX-FAZ2 2.2: the durable MessageSent → AnalyzeMessageCommand
    // consumer (subscribes ONLY when the kill-switch is ON).
    AiTriggerNatsHandler,
    AiResolver,
  ],
  exports: [AiPrivacyService, AiEgressGateService, AiPersonasRegistryService, AiTriggerConfig],
})
export class AiModule {}
