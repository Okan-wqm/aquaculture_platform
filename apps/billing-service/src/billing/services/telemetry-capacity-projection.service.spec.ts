import { getDataSourceToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import {
  createBaseEvent,
  type TelemetryCapacityEntitlementChangedEvent,
} from '@platform/event-contracts';
import { DataSource, EntityManager } from 'typeorm';

import { TelemetryCapacityProjectionService } from './telemetry-capacity-projection.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';

function event(
  activationState: TelemetryCapacityEntitlementChangedEvent['activationState'],
): TelemetryCapacityEntitlementChangedEvent {
  return {
    ...createBaseEvent<TelemetryCapacityEntitlementChangedEvent>(
      'TelemetryCapacityEntitlementChanged',
      TENANT_ID,
    ),
    operationId: '22222222-2222-4222-8222-222222222222',
    reservationId: '33333333-3333-4333-8333-333333333333',
    entitlementId: '44444444-4444-4444-8444-444444444444',
    entitlementVersion: 2,
    activationState,
    effectiveAt: '2026-08-25T12:00:00.000Z',
    capacityEnvelopeVersion: 7,
    sustainedIngressMessagesPerSecond: 20,
    sustainedMetricRowsPerMinute: 1_200,
  };
}

describe('TelemetryCapacityProjectionService', () => {
  it('projects only ACTIVE immutable entitlement snapshots', async () => {
    const manager = new EntityManager(new DataSource({ type: 'postgres' }));
    const query = jest
      .spyOn(manager, 'query')
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          entitlementId: '44444444-4444-4444-8444-444444444444',
          operationId: '22222222-2222-4222-8222-222222222222',
          reservationId: '33333333-3333-4333-8333-333333333333',
          tenantId: TENANT_ID,
          entitlementVersion: 2,
          effectiveAt: new Date('2026-08-25T12:00:00.000Z'),
          capacityEnvelopeVersion: 7,
          sustainedIngressMessagesPerSecond: 20,
          sustainedMetricRowsPerMinute: 1_200,
        },
      ]);
    const transaction = jest.fn(
      async (work: (transactionManager: EntityManager) => Promise<void>): Promise<void> =>
        work(manager),
    );
    const moduleRef = await Test.createTestingModule({
      providers: [
        TelemetryCapacityProjectionService,
        {
          provide: getDataSourceToken(),
          useValue: { transaction },
        },
      ],
    }).compile();
    const service = moduleRef.get(TelemetryCapacityProjectionService);

    await service.project(event('RESERVED'));
    expect(transaction).not.toHaveBeenCalled();

    await service.project(event('ACTIVE'));
    expect(query.mock.calls[0]?.[0]).toContain(
      'INSERT INTO billing.telemetry_capacity_entitlements',
    );
  });

  it('fails closed when an entitlement id reappears with different immutable data', async () => {
    const manager = new EntityManager(new DataSource({ type: 'postgres' }));
    jest
      .spyOn(manager, 'query')
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          entitlementId: '44444444-4444-4444-8444-444444444444',
          operationId: '22222222-2222-4222-8222-222222222222',
          reservationId: '33333333-3333-4333-8333-333333333333',
          tenantId: TENANT_ID,
          entitlementVersion: 2,
          effectiveAt: new Date('2026-08-25T12:00:00.000Z'),
          capacityEnvelopeVersion: 7,
          sustainedIngressMessagesPerSecond: 999,
          sustainedMetricRowsPerMinute: 1_200,
        },
      ]);
    const moduleRef = await Test.createTestingModule({
      providers: [
        TelemetryCapacityProjectionService,
        {
          provide: getDataSourceToken(),
          useValue: {
            transaction: (
              work: (transactionManager: EntityManager) => Promise<void>,
            ): Promise<void> => work(manager),
          },
        },
      ],
    }).compile();
    const service = moduleRef.get(TelemetryCapacityProjectionService);

    await expect(service.project(event('ACTIVE'))).rejects.toThrow(
      'immutable telemetry capacity entitlement conflict',
    );
  });
});
