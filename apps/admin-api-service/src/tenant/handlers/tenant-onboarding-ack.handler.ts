import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { SubscribeTo } from '@platform/event-bus';
import type {
  TenantOnboardingAckEvent,
  TenantOnboardingFailedEvent,
} from '@platform/event-contracts';
import { DataSource } from 'typeorm';

/**
 * The provisioning ACK ledger's writer (ADMIN-HIGH-014, ADR-0018).
 *
 * This class was written with `@EventPattern`, which binds through a Nest
 * microservice transport that admin-api never attaches — its `bootstrapService`
 * call declares no `natsTransport` — so both handlers bound to nothing and
 * `admin.tenant_onboarding_acks` recorded every service as never having
 * acknowledged. `@SubscribeTo` binds through `EventHandlerRegistryModule`,
 * which fails the boot rather than the binding, and delivers over a
 * durable JetStream consumer so an ACK published while admin-api is restarting
 * is redelivered instead of lost. The upsert below was already idempotent, so
 * at-least-once delivery needs nothing further from it.
 *
 * Closes: docs/reviews/admin-expert/2026-09-05-superadmin-audit.md#ADMIN-HIGH-014
 */
@Injectable()
export class TenantOnboardingAckHandler {
  private readonly logger = new Logger(TenantOnboardingAckHandler.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  @SubscribeTo({ topic: 'events.*.TenantOnboardingAck', durable: true, startFrom: 'latest' })
  async handleAck(event: TenantOnboardingAckEvent): Promise<void> {
    await this.record(event.operationId, event.tenantId, event.service, 'ACK', null);
  }

  @SubscribeTo({ topic: 'events.*.TenantOnboardingFailed', durable: true, startFrom: 'latest' })
  async handleFailed(event: TenantOnboardingFailedEvent): Promise<void> {
    await this.record(event.operationId, event.tenantId, event.service, 'FAILED', event.error);
  }

  private async record(
    operationId: string,
    tenantId: string,
    service: string,
    status: 'ACK' | 'FAILED',
    error: string | null,
  ): Promise<void> {
    await this.dataSource.query(
      `INSERT INTO admin.tenant_onboarding_acks (
         "operationId", "tenantId", service, status, error, "acknowledgedAt", "createdAt", "updatedAt"
       ) VALUES (
         $1, $2, $3, $4, $5, NOW(), NOW(), NOW()
       )
       ON CONFLICT ("operationId", service) DO UPDATE
         SET status = EXCLUDED.status,
             error = EXCLUDED.error,
             "acknowledgedAt" = NOW(),
             "updatedAt" = NOW()`,
      [operationId, tenantId, service, status, error],
    );
    this.logger.log(`Recorded tenant onboarding ${status} operation=${operationId} service=${service}`);
  }
}
