/**
 * @module MessagingAdminModule
 * @description Registers the NATS client and messaging admin controller
 * for proxying admin-panel messaging operations to messaging-service.
 *
 * Uses NestJS ClientsModule with Transport.NATS and the shared
 * buildNatsTransportOptions factory from @aquaculture/backend-common
 * for consistent auth/TLS configuration across the platform.
 *
 * @see ADR-012 Phase 3 (Compliance Admin API)
 */
import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { buildNatsTransportOptions } from '@aquaculture/backend-common';

import { MessagingAdminController } from './messaging-admin.controller';

@Module({
  imports: [
    /** SEC-H01: NATS client with shared auth factory for messaging-service proxy. */
    ClientsModule.register([
      {
        name: 'MESSAGING_NATS_CLIENT',
        transport: Transport.NATS,
        options: buildNatsTransportOptions('admin-api-service'),
      },
    ]),
  ],
  controllers: [MessagingAdminController],
})
export class MessagingAdminModule {}
