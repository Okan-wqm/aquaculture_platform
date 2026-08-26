import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { SecurityEventService } from '@aquaculture/backend-common/security';

import { AuditLogModule } from '../audit/audit.module';

import { IngressOwnerPolicyEntity } from './entities/ingress-owner-policy.entity';
import { IngressOwnerPolicyService } from './services/ingress-owner-policy.service';
import { OwnerPolicySnapshotResponder } from './services/owner-policy-snapshot.responder';
import { IngressOwnerPolicyController } from './ingress-owner-policy.controller';

/**
 * Versioned ingress-owner policy module. The append-only ledger is the sole
 * runtime authority for Node/Rust ownership and the sole responder on the
 * owner-policy snapshot subject.
 *
 * EventBusModule is NOT imported here — the admin-api app.module
 * already registers it globally via forRootAsync(), so
 * NatsEventBus + NatsRequestReply are available to this module's
 * providers through the DI container. Importing again would
 * create a second instance and defeat the one-mTLS-handshake
 * invariant from ADR-015.
 */
@Module({
  imports: [AuditLogModule, TypeOrmModule.forFeature([IngressOwnerPolicyEntity])],
  controllers: [IngressOwnerPolicyController],
  providers: [IngressOwnerPolicyService, OwnerPolicySnapshotResponder, SecurityEventService],
  exports: [IngressOwnerPolicyService],
})
export class IngestBackendPolicyModule {}
