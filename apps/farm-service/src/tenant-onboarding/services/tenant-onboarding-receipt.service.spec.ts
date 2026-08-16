import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { createBaseEvent, type TenantOnboardingRequestedEvent } from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';

import { TenantOnboardingReceiptState } from '../entities/tenant-onboarding-receipt.entity';
import {
  TenantOnboardingReceiptBusyError,
  TenantOnboardingReceiptService,
} from './tenant-onboarding-receipt.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const OPERATION_ID = '22222222-2222-4222-8222-222222222222';
const RECEIPT_ID = '33333333-3333-4333-8333-333333333333';
const REQUEST_HASH = 'a'.repeat(64);

function request(): TenantOnboardingRequestedEvent {
  return {
    ...createBaseEvent<TenantOnboardingRequestedEvent>('TenantOnboardingRequested', TENANT_ID, {
      aggregateId: TENANT_ID,
      aggregateType: 'Tenant',
    }),
    operationId: OPERATION_ID,
    attempt: 1,
    requestHash: REQUEST_HASH,
    name: 'Acme Aqua',
    slug: 'acme-aqua',
    moduleIds: ['44444444-4444-4444-8444-444444444444'],
  };
}

describe('TenantOnboardingReceiptService', () => {
  const build = async (query: jest.Mock, enqueue = jest.fn().mockResolvedValue(undefined)) => {
    const manager = { query };
    let commits = 0;
    let rollbacks = 0;
    const transaction = jest.fn(
      async (
        _isolation: string,
        work: (value: typeof manager) => Promise<TenantOnboardingReceiptState | object | void>,
      ) => {
        try {
          const result = await work(manager);
          commits += 1;
          return result;
        } catch (error) {
          rollbacks += 1;
          throw error;
        }
      },
    );
    const moduleRef = await Test.createTestingModule({
      providers: [
        TenantOnboardingReceiptService,
        { provide: getDataSourceToken(), useValue: { transaction } },
        { provide: OutboxPublisher, useValue: { enqueue } },
      ],
    }).compile();
    return {
      service: moduleRef.get(TenantOnboardingReceiptService),
      manager,
      enqueue,
      commits: (): number => commits,
      rollbacks: (): number => rollbacks,
    };
  };

  it('claims a new command using the database lease token written by the insert', async () => {
    let leaseToken = '';
    let fingerprint = '';
    const event = request();
    const query = jest.fn(async (sql: string, params: readonly unknown[]) => {
      if (sql.includes('INSERT INTO farm.tenant_onboarding_receipts')) {
        leaseToken = String(params[7]);
        fingerprint = String(params[5]);
        return [];
      }
      return [
        {
          id: RECEIPT_ID,
          operationId: event.operationId,
          attempt: event.attempt,
          tenantId: event.tenantId,
          requestEventId: event.eventId,
          requestHash: event.requestHash,
          requestFingerprint: fingerprint,
          state: TenantOnboardingReceiptState.PROCESSING,
          leaseToken,
          leaseActive: true,
          outcomeHash: null,
        },
      ];
    });
    const harness = await build(query);

    await expect(harness.service.claim(event)).resolves.toEqual({
      kind: 'claimed',
      receiptId: RECEIPT_ID,
      leaseToken,
    });
    expect(harness.commits()).toBe(1);
  });

  it('resolves a terminal redelivery from the durable receipt without reclaiming it', async () => {
    const event = request();
    let fingerprint = '';
    const query = jest.fn(async (sql: string, params: readonly unknown[]) => {
      if (sql.includes('INSERT INTO farm.tenant_onboarding_receipts')) {
        fingerprint = String(params[5]);
        return [];
      }
      return [
        {
          id: RECEIPT_ID,
          operationId: event.operationId,
          attempt: event.attempt,
          tenantId: event.tenantId,
          requestEventId: event.eventId,
          requestHash: event.requestHash,
          requestFingerprint: fingerprint,
          state: TenantOnboardingReceiptState.ACKNOWLEDGED,
          leaseToken: null,
          leaseActive: false,
          outcomeHash: 'b'.repeat(64),
        },
      ];
    });
    const { service } = await build(query);

    await expect(service.claim(event)).resolves.toEqual({
      kind: 'terminal-replay',
      receiptId: RECEIPT_ID,
      state: TenantOnboardingReceiptState.ACKNOWLEDGED,
    });
    expect(query.mock.calls.some(([sql]) => String(sql).startsWith('UPDATE'))).toBe(false);
  });

  it('rejects concurrent duplicate delivery while the first worker lease is active', async () => {
    const event = request();
    let fingerprint = '';
    const query = jest.fn(async (sql: string, params: readonly unknown[]) => {
      if (sql.includes('INSERT INTO farm.tenant_onboarding_receipts')) {
        fingerprint = String(params[5]);
        return [];
      }
      return [
        {
          id: RECEIPT_ID,
          operationId: event.operationId,
          attempt: event.attempt,
          tenantId: event.tenantId,
          requestEventId: event.eventId,
          requestHash: event.requestHash,
          requestFingerprint: fingerprint,
          state: TenantOnboardingReceiptState.PROCESSING,
          leaseToken: '55555555-5555-4555-8555-555555555555',
          leaseActive: true,
          outcomeHash: null,
        },
      ];
    });
    const { service } = await build(query);

    await expect(service.claim(event)).rejects.toBeInstanceOf(TenantOnboardingReceiptBusyError);
  });

  it('reclaims an expired processing lease without minting a second receipt', async () => {
    const event = request();
    let fingerprint = '';
    const staleLeaseToken = '55555555-5555-4555-8555-555555555555';
    const query = jest.fn(async (sql: string, params: readonly unknown[]) => {
      if (sql.includes('INSERT INTO farm.tenant_onboarding_receipts')) {
        fingerprint = String(params[5]);
        return [];
      }
      if (sql.includes('SELECT id, "operationId"')) {
        return [
          {
            id: RECEIPT_ID,
            operationId: event.operationId,
            attempt: event.attempt,
            tenantId: event.tenantId,
            requestEventId: event.eventId,
            requestHash: event.requestHash,
            requestFingerprint: fingerprint,
            state: TenantOnboardingReceiptState.PROCESSING,
            leaseToken: staleLeaseToken,
            leaseActive: false,
            outcomeHash: null,
          },
        ];
      }
      if (sql.includes('UPDATE farm.tenant_onboarding_receipts')) {
        return [{ id: RECEIPT_ID }];
      }
      return [];
    });
    const { service } = await build(query);

    const claim = await service.claim(event);

    expect(claim).toMatchObject({ kind: 'claimed', receiptId: RECEIPT_ID });
    expect(claim.kind === 'claimed' ? claim.leaseToken : staleLeaseToken).not.toBe(staleLeaseToken);
    expect(
      query.mock.calls.filter(([sql]) =>
        String(sql).includes('INSERT INTO farm.tenant_onboarding_receipts'),
      ),
    ).toHaveLength(1);
    expect(
      query.mock.calls.filter(([sql]) =>
        String(sql).includes('UPDATE farm.tenant_onboarding_receipts'),
      ),
    ).toHaveLength(1);
  });

  it('rejects a reused operation generation with different command coordinates', async () => {
    const event = request();
    let fingerprint = '';
    const query = jest.fn(async (sql: string, params: readonly unknown[]) => {
      if (sql.includes('INSERT INTO farm.tenant_onboarding_receipts')) {
        fingerprint = String(params[5]);
        return [];
      }
      return [
        {
          id: RECEIPT_ID,
          operationId: event.operationId,
          attempt: event.attempt,
          tenantId: event.tenantId,
          requestEventId: '77777777-7777-4777-8777-777777777777',
          requestHash: event.requestHash,
          requestFingerprint: fingerprint,
          state: TenantOnboardingReceiptState.PROCESSING,
          leaseToken: null,
          leaseActive: false,
          outcomeHash: null,
        },
      ];
    });
    const { service } = await build(query);

    await expect(service.claim(event)).rejects.toThrow('different command payload');
  });

  it('commits terminal receipt evidence and its ACK outbox row through one manager', async () => {
    const event = request();
    const query = jest
      .fn()
      .mockResolvedValue([{ id: RECEIPT_ID, completedAt: '2026-08-16T12:00:00.000Z' }]);
    const harness = await build(query);
    const claim = {
      kind: 'claimed' as const,
      receiptId: RECEIPT_ID,
      leaseToken: '66666666-6666-4666-8666-666666666666',
    };

    await harness.service.complete(event, claim, [
      { name: 'species', ok: true, seeded: 3, skipped: 0 },
    ]);

    expect(harness.enqueue).toHaveBeenCalledTimes(1);
    expect(harness.enqueue.mock.calls[0]?.[1]).toBe(harness.manager);
    expect(harness.enqueue.mock.calls[0]?.[0]).toMatchObject({
      eventType: 'TenantOnboardingAck',
      operationId: OPERATION_ID,
      attempt: 1,
      requestEventId: event.eventId,
      receiptId: RECEIPT_ID,
      service: 'farm-service',
    });
    expect(harness.commits()).toBe(1);
  });

  it('propagates an outbox failure so the receipt transaction rolls back after a crash window', async () => {
    const event = request();
    const query = jest
      .fn()
      .mockResolvedValue([{ id: RECEIPT_ID, completedAt: '2026-08-16T12:00:00.000Z' }]);
    const enqueue = jest.fn().mockRejectedValue(new Error('outbox unavailable'));
    const harness = await build(query, enqueue);

    await expect(
      harness.service.complete(
        event,
        {
          kind: 'claimed',
          receiptId: RECEIPT_ID,
          leaseToken: '66666666-6666-4666-8666-666666666666',
        },
        [{ name: 'species', ok: true, seeded: 3, skipped: 0 }],
      ),
    ).rejects.toThrow('outbox unavailable');
    expect(harness.commits()).toBe(0);
    expect(harness.rollbacks()).toBe(1);
  });
});
