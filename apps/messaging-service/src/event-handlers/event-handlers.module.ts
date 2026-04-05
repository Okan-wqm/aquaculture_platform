/**
 * @module EventHandlersModule
 * @description NATS event/request handlers for cross-service communication.
 * Handles membership verification, message batch retrieval, user deletion cascades,
 * and tenant provisioning events.
 * @see ADR-012 section 8 (Event Handlers)
 */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChannelMember } from '../channel/entities/channel-member.entity';
import { Message } from '../message/entities/message.entity';
import { PartitionModule } from '../partition/partition.module';
// ComplianceModule imported: MessagingNatsHandler.handleUserDeleted now calls
// LegalHoldService.isUnderLegalHold() to protect held channels from anonymization.
// ComplianceModule exports LegalHoldService so it can be injected here.
import { ComplianceModule } from '../compliance/compliance.module';
import { MessagingNatsHandler } from './messaging-nats.handler';

@Module({
  imports: [
    TypeOrmModule.forFeature([ChannelMember, Message]),
    PartitionModule,
    ComplianceModule,
  ],
  controllers: [MessagingNatsHandler],
})
export class EventHandlersModule {}
