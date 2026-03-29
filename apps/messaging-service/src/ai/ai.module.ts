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
import { ClientsModule, Transport } from '@nestjs/microservices';

// Feature module dependencies
import { ChannelModule } from '../channel/channel.module';
import { MessageModule } from '../message/message.module';
import { PresenceModule } from '../presence/presence.module';

// Entities
import { MessageAnalysis } from './entities/message-analysis.entity';
import { MessageEntityReference } from './entities/message-entity-reference.entity';
import { KnowledgeEntry } from './entities/knowledge-entry.entity';
import { EmbeddingsMetadata } from './entities/embeddings-metadata.entity';
import { Message } from '../message/entities/message.entity';
import { Channel } from '../channel/entities/channel.entity';
import { MessagingOutbox } from '../outbox/messaging-outbox.entity';

// Services
import { AiPrivacyService } from './services/ai-privacy.service';
import { EmbeddingService } from './services/embedding.service';
import { SentimentAnalysisService } from './services/sentiment-analysis.service';
import { KnowledgeExtractionService } from './services/knowledge-extraction.service';
import { AiChatBridgeService } from './services/ai-chat-bridge.service';
import { AiPersonasRegistryService } from './services/ai-personas-registry.service';

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
  EmbeddingService,
  SentimentAnalysisService,
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
      EmbeddingsMetadata,
      Message,
      Channel,
      MessagingOutbox,
    ]),
    CqrsModule,
    ClientsModule.register([
      {
        name: 'NATS_SERVICE',
        transport: Transport.NATS,
        options: {
          servers: [process.env['NATS_URL'] || 'nats://localhost:4222'],
        },
      },
    ]),
    // PresenceModule provides REDIS_CLIENT for AiPrivacyService
    PresenceModule,
    ChannelModule,
    MessageModule,
  ],
  providers: [
    ...commandHandlers,
    ...queryHandlers,
    ...services,
    AiResolver,
  ],
  exports: [AiPrivacyService, AiPersonasRegistryService],
})
export class AiModule {}
