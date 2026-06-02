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

import { MessagingCommandClientModule } from './messaging-command-client.module';
import { MessagingAdminController } from './messaging-admin.controller';

@Module({
  imports: [MessagingCommandClientModule],
  controllers: [MessagingAdminController],
})
export class MessagingAdminModule {}
