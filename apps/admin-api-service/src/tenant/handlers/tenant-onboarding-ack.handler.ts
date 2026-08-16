import { queryRowsNormalized } from '@aquaculture/backend-common/database';
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { IEventBus, IEventHandler } from '@platform/event-bus';
import {
  TENANT_ONBOARDING_WORKFLOW_V1,
  TenantOnboardingAckEvent,
  TenantOnboardingFailedEvent,
  validateTenantEvent,
} from '@platform/event-contracts';
import { DataSource } from 'typeorm';

type TenantOnboardingOutcomeEvent = TenantOnboardingAckEvent | TenantOnboardingFailedEvent;

interface RecordedOutcomeRow {
  eventId: string;
  operationId: string;
  attempt: number;
  tenantId: string;
  service: string;
  status: 'ACK' | 'FAILED';
  requestEventId: string;
  requestHash: string;
  receiptId: string;
  outcomeHash: string;
  error: string | null;
}

@Injectable()
export class TenantOnboardingAckHandler
  implements IEventHandler<TenantOnboardingOutcomeEvent>, OnModuleInit
{
  private readonly logger = new Logger(TenantOnboardingAckHandler.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @Inject('EVENT_BUS') private readonly eventBus: IEventBus,
  ) {}

  async onModuleInit(): Promise<void> {
    const subscription = TENANT_ONBOARDING_WORKFLOW_V1.subscription;
    const options = {
      durable: true,
      consumerVersion: subscription.consumerVersion,
      startFrom: subscription.startFrom,
      ackWait: subscription.ackWaitSeconds,
      maxRetries: subscription.maxDeliveries,
    } as const;
    await this.eventBus.subscribeWildcard(
      TENANT_ONBOARDING_WORKFLOW_V1.acknowledgement.eventType,
      this,
      options,
    );
    await this.eventBus.subscribeWildcard(
      TENANT_ONBOARDING_WORKFLOW_V1.failure.eventType,
      this,
      options,
    );
  }

  getEventType(): string {
    return TENANT_ONBOARDING_WORKFLOW_V1.acknowledgement.eventType;
  }

  async handle(event: TenantOnboardingOutcomeEvent): Promise<void> {
    const eventType: string = event.eventType;
    if (
      eventType !== TENANT_ONBOARDING_WORKFLOW_V1.acknowledgement.eventType &&
      eventType !== TENANT_ONBOARDING_WORKFLOW_V1.failure.eventType
    ) {
      throw new Error(`Unexpected tenant onboarding outcome type: ${eventType}`);
    }

    const validation = validateTenantEvent(eventType, event);
    if (!validation.valid) {
      throw new Error(`Invalid tenant onboarding outcome: ${validation.errors}`);
    }

    const status = event.eventType === 'TenantOnboardingAck' ? 'ACK' : 'FAILED';
    const error = event.eventType === 'TenantOnboardingFailed' ? event.error : null;

    await this.dataSource.transaction('SERIALIZABLE', async (manager) => {
      const inserted = queryRowsNormalized<RecordedOutcomeRow>(
        await manager.query(
          `INSERT INTO admin.tenant_onboarding_acks (
             id, "schemaVersion", "eventId", "operationId", attempt, "tenantId", service,
             status, "requestEventId", "requestHash", "receiptId", "outcomeHash", error,
             "acknowledgedAt", "createdAt", "updatedAt"
           )
           SELECT uuid_generate_v4(), $1, $2, r.id, $3, r."tenantId", $4,
                  $5, $6, $7, $8, $9, $10, $11::timestamptz, now(), now()
             FROM admin.tenant_provisioning_runs r
            WHERE r.id = $12
              AND r."tenantId" = $13
              AND r."onboardingAttempt" = $3
              AND r."onboardingRequestEventId" = $6
              AND r."requestHash" = $7
           ON CONFLICT ("operationId", service, attempt) DO NOTHING
           RETURNING "eventId", "operationId", attempt, "tenantId", service, status,
                     "requestEventId", "requestHash", "receiptId", "outcomeHash", error`,
          [
            TENANT_ONBOARDING_WORKFLOW_V1.schemaVersion,
            event.eventId,
            event.attempt,
            event.service,
            status,
            event.requestEventId,
            event.requestHash,
            event.receiptId,
            event.outcomeHash,
            error,
            event.acknowledgedAt,
            event.operationId,
            event.tenantId,
          ],
        ),
      )[0];

      if (inserted) {
        return;
      }

      const existing = queryRowsNormalized<RecordedOutcomeRow>(
        await manager.query(
          `SELECT "eventId", "operationId", attempt, "tenantId", service, status,
                  "requestEventId", "requestHash", "receiptId", "outcomeHash", error
             FROM admin.tenant_onboarding_acks
            WHERE "operationId" = $1 AND service = $2 AND attempt = $3
            FOR SHARE`,
          [event.operationId, event.service, event.attempt],
        ),
      )[0];

      if (!existing) {
        throw new Error(
          `Tenant onboarding outcome does not match the active command: ${event.operationId}/${event.attempt}`,
        );
      }
      this.assertExactReplay(existing, event, status, error);
    });

    this.logger.log(
      `Recorded durable tenant onboarding ${status} operation=${event.operationId} attempt=${event.attempt} service=${event.service}`,
    );
  }

  private assertExactReplay(
    existing: RecordedOutcomeRow,
    event: TenantOnboardingOutcomeEvent,
    status: 'ACK' | 'FAILED',
    error: string | null,
  ): void {
    if (
      existing.eventId !== event.eventId ||
      existing.tenantId !== event.tenantId ||
      existing.status !== status ||
      existing.requestEventId !== event.requestEventId ||
      existing.requestHash !== event.requestHash ||
      existing.receiptId !== event.receiptId ||
      existing.outcomeHash !== event.outcomeHash ||
      existing.error !== error
    ) {
      throw new Error(
        `Conflicting tenant onboarding outcome for ${event.operationId}/${event.attempt}/${event.service}`,
      );
    }
  }
}
