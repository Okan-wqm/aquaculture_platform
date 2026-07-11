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
import { EmbeddingsMetadata } from './entities/embeddings-metadata.entity';
import { UserAiConsent } from './entities/user-ai-consent.entity';
import { Message } from '../message/entities/message.entity';
import { Channel } from '../channel/entities/channel.entity';
// Services
import { AiEgressGateService } from './services/ai-egress-gate.service';
import { AiPrivacyService } from './services/ai-privacy.service';
import { EmbeddingService } from './services/embedding.service';
import { SentimentAnalysisService } from './services/sentiment-analysis.service';
import { KnowledgeExtractionService } from './services/knowledge-extraction.service';
import { AiChatBridgeService } from './services/ai-chat-bridge.service';
import { AiPersonasRegistryService } from './services/ai-personas-registry.service';

// AI Safety — SSRF / input filter / output PII scanner now come from the
// shared core module (libs/backend-common/src/ai-safety) extracted under
// AUDIT-HIGH-007. Instruction-hierarchy and tool-schema-validator remain
// service-local because they carry messaging-specific config.
import { AiSafetyCoreModule } from '@aquaculture/backend-common/ai-safety';
import { InstructionHierarchyService } from './safety/instruction-hierarchy.service';
import { ToolSchemaValidatorService } from './safety/tool-schema-validator.service';

// Command Handlers
import { AnalyzeMessageHandler } from './commands/analyze-message.handler';
import { ExtractKnowledgeHandler } from './commands/extract-knowledge.handler';

// Query Handlers
import { GetSentimentTrendsHandler } from './queries/get-sentiment-trends.handler';
import { SearchSimilarMessagesHandler } from './queries/search-similar-messages.handler';

// Resolver
import { AiResolver } from './resolvers/ai.resolver';

const commandHandlers = [
  AnalyzeMessageHandler,
  ExtractKnowledgeHandler,
];

const queryHandlers = [
  GetSentimentTrendsHandler,
  SearchSimilarMessagesHandler,
];

const services = [
  AiPrivacyService,
  AiEgressGateService,
  EmbeddingService,
  SentimentAnalysisService,
  KnowledgeExtractionService,
  AiChatBridgeService,
  AiPersonasRegistryService,
  // messaging-local AI safety extensions (SSRF / input filter / output PII
  // scanner now come from AiSafetyCoreModule imported below).
  InstructionHierarchyService,
  ToolSchemaValidatorService,
];

@Module({
  imports: [
    TypeOrmModule.forFeature([
      MessageAnalysis,
      MessageEntityReference,
      KnowledgeEntry,
      EmbeddingsMetadata,
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
    AiResolver,
  ],
  exports: [AiPrivacyService, AiEgressGateService, AiPersonasRegistryService],
})
export class AiModule {}
