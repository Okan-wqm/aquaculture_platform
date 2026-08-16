import * as crypto from 'crypto';

import { queryRowsNormalized } from '@aquaculture/backend-common/database';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import {
  createBaseEvent,
  TENANT_ONBOARDING_WORKFLOW_V1,
  type TenantOnboardingAckEvent,
  type TenantOnboardingFailedEvent,
  type TenantOnboardingRequestedEvent,
  validateTenantEvent,
} from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource, EntityManager } from 'typeorm';

import { TenantOnboardingReceiptState } from '../entities/tenant-onboarding-receipt.entity';

export interface TenantOnboardingSeederEvidence {
  readonly name: string;
  readonly ok: boolean;
  readonly seeded: number;
  readonly skipped: number;
  readonly error?: string;
}

export type TenantOnboardingReceiptClaim =
  | {
      readonly kind: 'claimed';
      readonly receiptId: string;
      readonly leaseToken: string;
    }
  | {
      readonly kind: 'terminal-replay';
      readonly receiptId: string;
      readonly state:
        | TenantOnboardingReceiptState.ACKNOWLEDGED
        | TenantOnboardingReceiptState.FAILED;
    };

interface ReceiptRow {
  id: string;
  operationId: string;
  attempt: number;
  tenantId: string;
  requestEventId: string;
  requestHash: string;
  requestFingerprint: string;
  state: TenantOnboardingReceiptState;
  leaseToken: string | null;
  leaseActive: boolean;
  outcomeHash: string | null;
}

interface CompletionRow {
  id: string;
  completedAt: Date | string;
}

export class TenantOnboardingReceiptBusyError extends Error {
  constructor(operationId: string, attempt: number) {
    super(`Tenant onboarding receipt ${operationId}/${attempt} is owned by an active worker`);
    this.name = 'TenantOnboardingReceiptBusyError';
  }
}

@Injectable()
export class TenantOnboardingReceiptService {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  async claim(event: TenantOnboardingRequestedEvent): Promise<TenantOnboardingReceiptClaim> {
    this.assertValidRequest(event);
    const requestFingerprint = this.requestFingerprint(event);
    const leaseToken = crypto.randomUUID();

    return this.dataSource.transaction('SERIALIZABLE', async (manager) => {
      await manager.query(
        `INSERT INTO farm.tenant_onboarding_receipts (
           id, "operationId", attempt, "tenantId", "requestEventId", "requestHash",
           "requestFingerprint", state, "leaseToken", "leaseExpiresAt",
           "processingAttempts", "createdAt", "updatedAt"
         ) VALUES (
           uuid_generate_v4(), $1, $2, $3, $4, $5, $6, $7, $8,
           now() + ($9::text)::interval, 1, now(), now()
         )
         ON CONFLICT ("operationId", attempt) DO NOTHING`,
        [
          event.operationId,
          event.attempt,
          event.tenantId,
          event.eventId,
          event.requestHash,
          requestFingerprint,
          TenantOnboardingReceiptState.PROCESSING,
          leaseToken,
          `${TENANT_ONBOARDING_WORKFLOW_V1.ownerReceiptLeaseSeconds} seconds`,
        ],
      );

      const receipt = await this.readLockedReceipt(manager, event.operationId, event.attempt);
      this.assertSameRequest(receipt, event, requestFingerprint);

      if (
        receipt.state === TenantOnboardingReceiptState.ACKNOWLEDGED ||
        receipt.state === TenantOnboardingReceiptState.FAILED
      ) {
        return { kind: 'terminal-replay', receiptId: receipt.id, state: receipt.state };
      }

      if (receipt.leaseToken === leaseToken) {
        return { kind: 'claimed', receiptId: receipt.id, leaseToken };
      }

      if (receipt.leaseActive) {
        throw new TenantOnboardingReceiptBusyError(event.operationId, event.attempt);
      }

      const reclaimed = queryRowsNormalized<{ id: string }>(
        await manager.query(
          `UPDATE farm.tenant_onboarding_receipts
              SET "leaseToken" = $3,
                  "leaseExpiresAt" = now() + ($4::text)::interval,
                  "processingAttempts" = "processingAttempts" + 1,
                  "updatedAt" = now()
            WHERE "operationId" = $1
              AND attempt = $2
              AND state = $5
              AND "leaseExpiresAt" <= now()
          RETURNING id`,
          [
            event.operationId,
            event.attempt,
            leaseToken,
            `${TENANT_ONBOARDING_WORKFLOW_V1.ownerReceiptLeaseSeconds} seconds`,
            TenantOnboardingReceiptState.PROCESSING,
          ],
        ),
      );
      if (!reclaimed[0]) {
        throw new TenantOnboardingReceiptBusyError(event.operationId, event.attempt);
      }

      return { kind: 'claimed', receiptId: receipt.id, leaseToken };
    });
  }

  async complete(
    event: TenantOnboardingRequestedEvent,
    claim: Extract<TenantOnboardingReceiptClaim, { kind: 'claimed' }>,
    seeders: readonly TenantOnboardingSeederEvidence[],
  ): Promise<void> {
    const failed = seeders.filter((seeder) => !seeder.ok);
    const state =
      failed.length === 0
        ? TenantOnboardingReceiptState.ACKNOWLEDGED
        : TenantOnboardingReceiptState.FAILED;
    const error =
      failed.length === 0
        ? null
        : failed
            .map((seeder) => `${seeder.name}: ${seeder.error ?? 'failed'}`)
            .join('; ')
            .slice(0, 4000);
    const evidence = {
      schemaVersion: TENANT_ONBOARDING_WORKFLOW_V1.schemaVersion,
      seeders,
    } as const;
    const outcomeHash = this.sha256(
      JSON.stringify({
        operationId: event.operationId,
        attempt: event.attempt,
        requestEventId: event.eventId,
        requestHash: event.requestHash,
        state,
        evidence,
        error,
      }),
    );

    await this.dataSource.transaction('SERIALIZABLE', async (manager) => {
      const completed = queryRowsNormalized<CompletionRow>(
        await manager.query(
          `UPDATE farm.tenant_onboarding_receipts
              SET state = $4,
                  "outcomeHash" = $5,
                  evidence = $6::jsonb,
                  error = $7,
                  "completedAt" = now(),
                  "leaseToken" = NULL,
                  "leaseExpiresAt" = NULL,
                  "updatedAt" = now()
            WHERE id = $1
              AND "leaseToken" = $2
              AND "requestEventId" = $3
              AND state = $8
          RETURNING id, "completedAt"`,
          [
            claim.receiptId,
            claim.leaseToken,
            event.eventId,
            state,
            outcomeHash,
            JSON.stringify(evidence),
            error,
            TenantOnboardingReceiptState.PROCESSING,
          ],
        ),
      )[0];

      if (!completed) {
        throw new Error(
          `Tenant onboarding receipt lease was lost before completion: ${event.operationId}/${event.attempt}`,
        );
      }

      const acknowledgedAt = this.toIso(completed.completedAt);
      const response =
        state === TenantOnboardingReceiptState.ACKNOWLEDGED
          ? this.ackEvent(event, claim.receiptId, outcomeHash, acknowledgedAt)
          : this.failedEvent(event, claim.receiptId, outcomeHash, acknowledgedAt, error);

      await this.outboxPublisher.enqueue(response, manager, {
        aggregateId: event.tenantId,
        idempotencyKey: `tenant-onboarding-result:${event.operationId}:${event.attempt}:farm-service`,
      });
    });
  }

  private async readLockedReceipt(
    manager: EntityManager,
    operationId: string,
    attempt: number,
  ): Promise<ReceiptRow> {
    const row = queryRowsNormalized<ReceiptRow>(
      await manager.query(
        `SELECT id, "operationId", attempt, "tenantId", "requestEventId", "requestHash",
                "requestFingerprint", state, "leaseToken",
                ("leaseExpiresAt" > now()) AS "leaseActive", "outcomeHash"
           FROM farm.tenant_onboarding_receipts
          WHERE "operationId" = $1 AND attempt = $2
          FOR UPDATE`,
        [operationId, attempt],
      ),
    )[0];
    if (!row) {
      throw new Error(`Tenant onboarding receipt was not created: ${operationId}/${attempt}`);
    }
    return row;
  }

  private assertValidRequest(event: TenantOnboardingRequestedEvent): void {
    const result = validateTenantEvent(TENANT_ONBOARDING_WORKFLOW_V1.request.eventType, event);
    if (!result.valid) {
      throw new Error(`Invalid tenant onboarding request: ${result.errors}`);
    }
  }

  private assertSameRequest(
    receipt: ReceiptRow,
    event: TenantOnboardingRequestedEvent,
    requestFingerprint: string,
  ): void {
    if (
      receipt.tenantId !== event.tenantId ||
      receipt.requestEventId !== event.eventId ||
      receipt.requestHash !== event.requestHash ||
      receipt.requestFingerprint !== requestFingerprint
    ) {
      throw new Error(
        `Tenant onboarding operation ${event.operationId}/${event.attempt} was replayed with a different command payload`,
      );
    }
  }

  private requestFingerprint(event: TenantOnboardingRequestedEvent): string {
    return this.sha256(
      JSON.stringify({
        operationId: event.operationId,
        attempt: event.attempt,
        tenantId: event.tenantId,
        requestEventId: event.eventId,
        requestHash: event.requestHash,
        name: event.name,
        slug: event.slug,
        moduleIds: [...event.moduleIds].sort(),
      }),
    );
  }

  private ackEvent(
    request: TenantOnboardingRequestedEvent,
    receiptId: string,
    outcomeHash: string,
    acknowledgedAt: string,
  ): TenantOnboardingAckEvent {
    return {
      ...createBaseEvent<TenantOnboardingAckEvent>(
        TENANT_ONBOARDING_WORKFLOW_V1.acknowledgement.eventType,
        request.tenantId,
        {
          aggregateId: request.tenantId,
          aggregateType: 'Tenant',
          correlationId: request.correlationId,
          causationId: request.eventId,
        },
      ),
      operationId: request.operationId,
      attempt: request.attempt,
      requestEventId: request.eventId,
      requestHash: request.requestHash,
      receiptId,
      outcomeHash,
      service: TENANT_ONBOARDING_WORKFLOW_V1.ownerServices[0],
      acknowledgedAt,
    };
  }

  private failedEvent(
    request: TenantOnboardingRequestedEvent,
    receiptId: string,
    outcomeHash: string,
    acknowledgedAt: string,
    error: string | null,
  ): TenantOnboardingFailedEvent {
    if (error === null) {
      throw new Error('A failed tenant onboarding receipt requires an error');
    }
    return {
      ...createBaseEvent<TenantOnboardingFailedEvent>(
        TENANT_ONBOARDING_WORKFLOW_V1.failure.eventType,
        request.tenantId,
        {
          aggregateId: request.tenantId,
          aggregateType: 'Tenant',
          correlationId: request.correlationId,
          causationId: request.eventId,
        },
      ),
      operationId: request.operationId,
      attempt: request.attempt,
      requestEventId: request.eventId,
      requestHash: request.requestHash,
      receiptId,
      outcomeHash,
      service: TENANT_ONBOARDING_WORKFLOW_V1.ownerServices[0],
      acknowledgedAt,
      error,
    };
  }

  private sha256(value: string): string {
    return crypto.createHash('sha256').update(value).digest('hex');
  }

  private toIso(value: Date | string): string {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new Error('Tenant onboarding receipt completion timestamp is invalid');
    }
    return date.toISOString();
  }
}
