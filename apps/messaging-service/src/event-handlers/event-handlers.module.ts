/**
 * @module EventHandlersModule
 * @description NATS event/request handlers for cross-service communication.
 * Handles membership verification, message batch retrieval, user deletion cascades,
 * tenant provisioning events, and admin-panel compliance proxy operations.
 * @see ADR-012 section 8 (Event Handlers)
 */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CqrsModule } from '@nestjs/cqrs';
import { ChannelMember } from '../channel/entities/channel-member.entity';
import { Message } from '../message/entities/message.entity';
import { PartitionModule } from '../partition/partition.module';
// ComplianceModule imported: MessagingNatsHandler.handleUserDeleted now calls
// LegalHoldService.isUnderLegalHold() to protect held channels from anonymization.
// ComplianceModule exports LegalHoldService so it can be injected here.
// Also provides RetentionPolicyService, ComplianceAuditService, DataExportService
// for the admin NATS handler.
import { ComplianceModule } from '../compliance/compliance.module';
// AiModule imported: MessagingAdminNatsHandler uses AiPersonasRegistryService
// for the admin-panel AI personas configuration endpoint.
import { AiModule } from '../ai/ai.module';
import { MessagingNatsHandler } from './messaging-nats.handler';
import { MessagingAdminNatsHandler } from './messaging-admin-nats.handler';

@Module({
  imports: [
    TypeOrmModule.forFeature([ChannelMember, Message]),
    CqrsModule,
    PartitionModule,
    ComplianceModule,
    AiModule,
  ],
  controllers: [MessagingNatsHandler, MessagingAdminNatsHandler],
})
export class EventHandlersModule {}
