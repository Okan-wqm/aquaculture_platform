/**
 * @module EventHandlersModule
 * @description NATS event/request handlers for cross-service communication.
 * Handles membership verification, message batch retrieval, user deletion cascades,
 * tenant provisioning events, and admin-panel compliance proxy operations.
 * @see ADR-012 section 8 (Event Handlers)
 */
import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AiModule } from '../ai/ai.module';
import { ChannelMember } from '../channel/entities/channel-member.entity';
import { ComplianceModule } from '../compliance/compliance.module';
import { Message } from '../message/entities/message.entity';
import { MessageModule } from '../message/message.module';
import { PartitionModule } from '../partition/partition.module';
import { PresenceModule } from '../presence/presence.module';
// ComplianceModule exports the transaction-owning legal-hold mutation authority
// used by MessagingNatsHandler.handleUserDeleted.
// Also provides RetentionPolicyService, ComplianceAuditService, DataExportService
// for the admin NATS handler.
// AiModule imported: MessagingAdminNatsHandler uses AiPersonasRegistryService
// for the admin-panel AI personas configuration endpoint.

import { MessagingAdminNatsHandler } from './messaging-admin-nats.handler';
import { MessagingNatsHandler } from './messaging-nats.handler';

@Module({
  imports: [
    TypeOrmModule.forFeature([ChannelMember, Message]),
    CqrsModule,
    PartitionModule,
    PresenceModule,
    ComplianceModule,
    AiModule,
    // MessageModule exports MediaService — MessagingNatsHandler.getMessageForBroadcast
    // signs attachment download URLs when hydrating a message for the WS bridge.
    MessageModule,
  ],
  controllers: [MessagingNatsHandler, MessagingAdminNatsHandler],
})
export class EventHandlersModule {}
