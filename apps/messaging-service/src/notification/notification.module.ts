/**
 * @module NotificationModule (messaging-service)
 * @description Registers the MessagingPushService which dispatches push
 * notification commands to the notification-service when messages are sent.
 * Imports PresenceModule for online/offline user checks.
 * @see ADR-012 section 5 (Push Notifications)
 */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { buildNatsTransportOptions } from '@aquaculture/backend-common/nats';
import { ChannelMember } from '../channel/entities/channel-member.entity';
import { PresenceModule } from '../presence/presence.module';
import { MessageModule } from '../message/message.module';
import { MessagingPushService } from './messaging-push.service';
import { MessagingPushNatsHandler } from './messaging-push-nats.handler';

@Module({
  imports: [
    TypeOrmModule.forFeature([ChannelMember]),
    /** SEC-H01: NATS client with shared auth factory. */
    ClientsModule.register([
      {
        name: 'NATS_SERVICE',
        transport: Transport.NATS,
        options: buildNatsTransportOptions('messaging-service'),
      },
    ]),
    PresenceModule,
    MessageModule,
  ],
  // MessagingPushNatsHandler owns the durable MessageSent subscription that
  // drives MessagingPushService.handleMessageSent (MSG-HIGH-004). EVENT_BUS is
  // provided by the global EventBusModule registered in app.module.
  providers: [MessagingPushService, MessagingPushNatsHandler],
  exports: [MessagingPushService],
})
export class MessagingNotificationModule {}
