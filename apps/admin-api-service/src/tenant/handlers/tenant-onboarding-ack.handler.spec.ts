import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { createBaseEvent, type TenantOnboardingAckEvent } from '@platform/event-contracts';

import { TenantOnboardingAckHandler } from './tenant-onboarding-ack.handler';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const OPERATION_ID = '22222222-2222-4222-8222-222222222222';
const REQUEST_EVENT_ID = '33333333-3333-4333-8333-333333333333';
const RECEIPT_ID = '44444444-4444-4444-8444-444444444444';
const HASH = 'a'.repeat(64);

function ack(): TenantOnboardingAckEvent {
  return {
    ...createBaseEvent<TenantOnboardingAckEvent>('TenantOnboardingAck', TENANT_ID, {
      aggregateId: TENANT_ID,
      aggregateType: 'Tenant',
      causationId: REQUEST_EVENT_ID,
    }),
    operationId: OPERATION_ID,
    attempt: 1,
    requestEventId: REQUEST_EVENT_ID,
    requestHash: HASH,
    receiptId: RECEIPT_ID,
    outcomeHash: HASH,
    service: 'farm-service',
    acknowledgedAt: '2026-08-16T12:00:00.000Z',
  };
}

describe('TenantOnboardingAckHandler', () => {
  const build = async (query: jest.Mock) => {
    const manager = { query };
    const transaction = jest.fn(
      async (_isolation: string, work: (value: typeof manager) => Promise<void>) => work(manager),
    );
    const subscribeWildcard = jest.fn().mockResolvedValue(undefined);
    const moduleRef = await Test.createTestingModule({
      providers: [
        TenantOnboardingAckHandler,
        { provide: getDataSourceToken(), useValue: { transaction } },
        { provide: 'EVENT_BUS', useValue: { subscribeWildcard } },
      ],
    }).compile();
    return {
      handler: moduleRef.get(TenantOnboardingAckHandler),
      subscribeWildcard,
      transaction,
    };
  };

  it('registers durable ACK and FAILED consumers from the workflow catalogue', async () => {
    const harness = await build(jest.fn());
    await harness.handler.onModuleInit();

    expect(harness.subscribeWildcard).toHaveBeenCalledTimes(2);
    expect(harness.subscribeWildcard).toHaveBeenNthCalledWith(
      1,
      'TenantOnboardingAck',
      harness.handler,
      expect.objectContaining({ consumerVersion: 'tenant-onboarding-v1' }),
    );
    expect(harness.subscribeWildcard).toHaveBeenNthCalledWith(
      2,
      'TenantOnboardingFailed',
      harness.handler,
      expect.objectContaining({ consumerVersion: 'tenant-onboarding-v1' }),
    );
  });

  it('persists an ACK only through the active command generation correlation', async () => {
    const event = ack();
    const query = jest.fn().mockResolvedValueOnce([
      {
        eventId: event.eventId,
        operationId: event.operationId,
        attempt: event.attempt,
        tenantId: event.tenantId,
        service: event.service,
        status: 'ACK',
        requestEventId: event.requestEventId,
        requestHash: event.requestHash,
        receiptId: event.receiptId,
        outcomeHash: event.outcomeHash,
        error: null,
      },
    ]);
    const harness = await build(query);

    await harness.handler.handle(event);

    expect(query.mock.calls[0]?.[0]).toContain('r."onboardingAttempt" = $3');
    expect(query.mock.calls[0]?.[0]).toContain('r."onboardingRequestEventId" = $6');
    expect(query.mock.calls[0]?.[0]).not.toContain('DO UPDATE');
  });

  it('rejects a conflicting duplicate instead of overwriting immutable evidence', async () => {
    const event = ack();
    const query = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          eventId: '55555555-5555-4555-8555-555555555555',
          operationId: event.operationId,
          attempt: event.attempt,
          tenantId: event.tenantId,
          service: event.service,
          status: 'ACK',
          requestEventId: event.requestEventId,
          requestHash: event.requestHash,
          receiptId: event.receiptId,
          outcomeHash: event.outcomeHash,
          error: null,
        },
      ]);
    const harness = await build(query);

    await expect(harness.handler.handle(event)).rejects.toThrow(
      'Conflicting tenant onboarding outcome',
    );
  });

  it('accepts an exact JetStream redelivery without mutating its immutable evidence', async () => {
    const event = ack();
    const query = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          eventId: event.eventId,
          operationId: event.operationId,
          attempt: event.attempt,
          tenantId: event.tenantId,
          service: event.service,
          status: 'ACK',
          requestEventId: event.requestEventId,
          requestHash: event.requestHash,
          receiptId: event.receiptId,
          outcomeHash: event.outcomeHash,
          error: null,
        },
      ]);
    const harness = await build(query);

    await expect(harness.handler.handle(event)).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls.every(([sql]) => !String(sql).includes('DO UPDATE'))).toBe(true);
  });

  it('rejects a generation that is neither active nor an exact durable replay', async () => {
    const harness = await build(jest.fn().mockResolvedValue([]));
    const event = ack();

    await expect(harness.handler.handle(event)).rejects.toThrow(
      `does not match the active command: ${event.operationId}/${event.attempt}`,
    );
  });
});
