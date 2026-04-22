import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { IngestBackendPolicyStateEntity } from './entities/ingest-backend-policy-state.entity';
import { IngestBackendPolicyService } from './services/ingest-backend-policy.service';
import { PolicySnapshotResponder } from './services/policy-snapshot.responder';

/**
 * ADR-031 ingest-backend policy module. Owns the single-row
 * SoT for per-tenant IngestBackend routing + the NATS wire
 * surfaces (responder for `policy.ingest_backend.snapshot`,
 * publisher for `policy.ingest_backend.changed`).
 *
 * EventBusModule is NOT imported here — the admin-api app.module
 * already registers it globally via forRootAsync(), so
 * NatsEventBus + NatsRequestReply are available to this module's
 * providers through the DI container. Importing again would
 * create a second instance and defeat the one-mTLS-handshake
 * invariant from ADR-015.
 */
@Module({
  imports: [TypeOrmModule.forFeature([IngestBackendPolicyStateEntity])],
  providers: [IngestBackendPolicyService, PolicySnapshotResponder],
  exports: [IngestBackendPolicyService],
})
export class IngestBackendPolicyModule {}
