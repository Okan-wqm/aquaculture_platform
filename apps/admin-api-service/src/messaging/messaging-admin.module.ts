/**
 * @module MessagingAdminModule
 * @description Registers the NATS client and messaging admin controller
 * for proxying admin-panel messaging operations to messaging-service.
 *
 * Uses NestJS ClientsModule with the platform-owned NatsV3Client
 * customClass from @aquaculture/backend-common, resolving auth/TLS
 * configuration by serviceName for consistency across the platform.
 *
 * @see ADR-012 Phase 3 (Compliance Admin API)
 */
import { Module } from '@nestjs/common';
import { ClientsModule } from '@nestjs/microservices';
import { NatsV3Client } from '@aquaculture/backend-common/nats';

import { MessagingAdminController } from './messaging-admin.controller';

@Module({
  imports: [
    /** SEC-H01: NATS client with shared auth factory for messaging-service proxy. */
    ClientsModule.register([
      {
        name: 'MESSAGING_NATS_CLIENT',
        customClass: NatsV3Client,
        options: { serviceName: 'admin-api-service' },
      },
    ]),
  ],
  controllers: [MessagingAdminController],
})
export class MessagingAdminModule {}
