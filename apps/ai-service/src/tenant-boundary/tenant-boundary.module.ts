import { Module } from '@nestjs/common';
import { ClientsModule } from '@nestjs/microservices';
import { NatsV3Client } from '@aquaculture/backend-common/nats';
import { SecurityEventService } from '@aquaculture/backend-common/security';

import { AI_TENANT_BOUND_TRANSPORT, TenantBoundNatsClient } from './tenant-bound-nats.client';
import { TenantBoundaryViolationReporter } from './tenant-boundary-violation.reporter';

/**
 * The AI tenant boundary (K10 / PR-T1, MT-HIGH-062).
 *
 * WHY the raw transport is registered HERE and not exported: tool modules
 * import this module and get `TenantBoundNatsClient` only. The transport token
 * is private to the boundary, so a tool cannot inject the raw client even by
 * mistake (cert-identity factory, ADR-015).
 */
@Module({
  imports: [
    ClientsModule.register([
      {
        name: AI_TENANT_BOUND_TRANSPORT,
        customClass: NatsV3Client,
        options: { serviceName: 'ai-service' },
      },
    ]),
  ],
  providers: [SecurityEventService, TenantBoundaryViolationReporter, TenantBoundNatsClient],
  exports: [TenantBoundNatsClient],
})
export class TenantBoundaryModule {}
