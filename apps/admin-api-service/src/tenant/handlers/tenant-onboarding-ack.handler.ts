import { Controller, Logger } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { InjectDataSource } from '@nestjs/typeorm';
import type {
  TenantOnboardingAckEvent,
  TenantOnboardingFailedEvent,
} from '@platform/event-contracts';
import { DataSource } from 'typeorm';

@Controller()
export class TenantOnboardingAckHandler {
  private readonly logger = new Logger(TenantOnboardingAckHandler.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  @EventPattern('events.*.TenantOnboardingAck')
  async handleAck(@Payload() event: TenantOnboardingAckEvent): Promise<void> {
    await this.record(event.operationId, event.tenantId, event.service, 'ACK', null);
  }

  @EventPattern('events.*.TenantOnboardingFailed')
  async handleFailed(@Payload() event: TenantOnboardingFailedEvent): Promise<void> {
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
