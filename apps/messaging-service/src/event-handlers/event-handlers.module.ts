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
import { MessagingNatsHandler } from './messaging-nats.handler';

@Module({
  imports: [
    TypeOrmModule.forFeature([ChannelMember, Message]),
    PartitionModule,
  ],
  controllers: [MessagingNatsHandler],
})
export class EventHandlersModule {}
