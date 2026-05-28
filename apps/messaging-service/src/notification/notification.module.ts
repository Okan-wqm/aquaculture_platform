/**
 * @module NotificationModule (messaging-service)
 * @description Registers the MessagingPushService which dispatches push
 * notification commands to the notification-service when messages are sent.
 * Imports PresenceModule for online/offline user checks.
 * @see ADR-012 section 5 (Push Notifications)
 */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChannelMember } from '../channel/entities/channel-member.entity';
import { PresenceModule } from '../presence/presence.module';
import { MessagingPushService } from './messaging-push.service';
import { MessagingPushNatsHandler } from './messaging-push-nats.handler';

@Module({
  imports: [
    TypeOrmModule.forFeature([ChannelMember]),
    PresenceModule,
  ],
  providers: [MessagingPushService, MessagingPushNatsHandler],
  exports: [MessagingPushService],
})
export class MessagingNotificationModule {}
