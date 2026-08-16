import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ClientsModule } from '@nestjs/microservices';
import { NatsV3Client } from '@aquaculture/backend-common/nats';
import { Message } from '../message/entities/message.entity';
import { MessagingOutbox } from '../outbox/messaging-outbox.entity';
import { PresenceModule } from '../presence/presence.module';
import { ComplianceModule } from '../compliance/compliance.module';
import { GdprService } from './gdpr.service';

/**
 * @module GdprModule
 * @description GDPR compliance module providing data export and anonymisation.
 * Registers its own NATS_SERVICE client because NestJS ClientsModule.register()
 * is NOT global -- each module that injects NATS_SERVICE must import it.
 * Integrates with ComplianceModule for the legal-hold mutation authority.
 * @see ADR-012 section 9 (GDPR Compliance)
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Message, MessagingOutbox]),
    /** SEC-H01: NATS client with shared auth factory. */
    ClientsModule.register([
      {
        name: 'NATS_SERVICE',
        customClass: NatsV3Client,
        options: { serviceName: 'messaging-service' },
      },
    ]),
    // PresenceModule provides the REDIS_CLIENT token
    PresenceModule,
    // ComplianceModule provides LegalHoldDestructiveMutationAuthority.
    forwardRef(() => ComplianceModule),
  ],
  providers: [GdprService],
  exports: [GdprService],
})
export class GdprModule {}
