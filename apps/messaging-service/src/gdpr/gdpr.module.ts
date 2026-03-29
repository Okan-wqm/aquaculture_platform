import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Message } from '../message/entities/message.entity';
import { MessagingOutbox } from '../outbox/messaging-outbox.entity';
import { PresenceModule } from '../presence/presence.module';
import { GdprService } from './gdpr.service';

/**
 * @module GdprModule
 * @description GDPR compliance module providing data export and anonymisation.
 * NATS_SERVICE is provided globally via AppModule's ClientsModule registration.
 * @see ADR-012 section 9 (GDPR Compliance)
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Message, MessagingOutbox]),
    // PresenceModule provides the REDIS_CLIENT token
    PresenceModule,
  ],
  providers: [GdprService],
  exports: [GdprService],
})
export class GdprModule {}
