import { getDataSourceToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource, EntityManager } from 'typeorm';

import { TelemetryCapacityService } from './telemetry-capacity.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const OPERATION_ID = '22222222-2222-4222-8222-222222222222';

interface QueryResponse {
  matcher: RegExp;
  rows: unknown[];
}

function managerWith(responses: QueryResponse[]): EntityManager {
  const manager = new EntityManager(new DataSource({ type: 'postgres' }));
  jest.spyOn(manager, 'query').mockImplementation(async (sql: string) => {
    const response = responses.find(({ matcher }) => matcher.test(sql));
    if (!response) throw new Error(`Unexpected SQL: ${sql}`);
    return response.rows;
  });
  return manager;
}

describe('TelemetryCapacityService', () => {
  const enqueue = jest.fn().mockResolvedValue(undefined);
  let transaction: jest.Mock;
  let service: TelemetryCapacityService;

  beforeEach(async () => {
    enqueue.mockClear();
    transaction = jest.fn(
      async (_isolation: string, work: (manager: EntityManager) => Promise<unknown>) =>
        work(
          managerWith([
            { matcher: /FROM admin\.telemetry_capacity_entitlements[\s\S]+operation_id/, rows: [] },
            {
              matcher: /FROM admin\.telemetry_capacity_envelopes[\s\S]+FOR UPDATE/,
              rows: [
                {
                  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                  version: 7,
                  ingressLimit: 100,
                  rowLimit: 1_000,
                },
              ],
            },
            { matcher: /current_tenant_entitlement/, rows: [] },
            { matcher: /capacity_commitment_totals/, rows: [{ ingress: '90', rows: '900' }] },
            { matcher: /next_entitlement_version/, rows: [{ version: '1' }] },
            {
              matcher: /INSERT INTO admin\.telemetry_capacity_entitlements/,
              rows: [
                {
                  entitlementId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                  reservationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
                },
              ],
            },
            { matcher: /INSERT INTO admin\.telemetry_capacity_activation_events/, rows: [] },
          ]),
        ),
    );
    const moduleRef = await Test.createTestingModule({
      providers: [
        TelemetryCapacityService,
        { provide: getDataSourceToken(), useValue: { transaction } satisfies Partial<DataSource> },
        { provide: OutboxPublisher, useValue: { enqueue } },
      ],
    }).compile();
    service = moduleRef.get(TelemetryCapacityService);
  });

  it('locks the current envelope and leaves an over-capacity request pending', async () => {
    const result = await service.reserve({
      operationId: OPERATION_ID,
      tenantId: TENANT_ID,
      sustainedIngressMessagesPerSecond: 20,
      sustainedMetricRowsPerMinute: 200,
      effectiveAt: new Date('2026-08-25T12:00:00.000Z'),
    });

    expect(transaction).toHaveBeenCalledWith('SERIALIZABLE', expect.any(Function));
    expect(result.activationState).toBe('PENDING_CAPACITY');
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'TelemetryCapacityEntitlementChanged',
        activationState: 'PENDING_CAPACITY',
        capacityEnvelopeVersion: 7,
      }),
      expect.anything(),
      expect.objectContaining({ idempotencyKey: `telemetry-capacity:${OPERATION_ID}` }),
    );
  });

  it('returns the immutable operation snapshot on replay without another outbox event', async () => {
    const replayManager = managerWith([
      {
        matcher: /FROM admin\.telemetry_capacity_entitlements[\s\S]+operation_id/,
        rows: [
          {
            operationId: OPERATION_ID,
            tenantId: TENANT_ID,
            reservationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            entitlementId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            entitlementVersion: 1,
            activationState: 'RESERVED',
            effectiveAt: new Date('2026-08-25T12:00:00.000Z'),
            capacityEnvelopeVersion: 7,
            sustainedIngressMessagesPerSecond: 10,
            sustainedMetricRowsPerMinute: 100,
          },
        ],
      },
    ]);
    transaction.mockImplementationOnce(
      async (_isolation: string, work: (manager: EntityManager) => Promise<unknown>) =>
        work(replayManager),
    );

    const result = await service.reserve({
      operationId: OPERATION_ID,
      tenantId: TENANT_ID,
      sustainedIngressMessagesPerSecond: 10,
      sustainedMetricRowsPerMinute: 100,
      effectiveAt: new Date('2026-08-25T12:00:00.000Z'),
    });

    expect(result.activationState).toBe('RESERVED');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('activates only after the tenant hypertable and all required caggs exist', async () => {
    const activationManager = managerWith([
      {
        matcher: /capacity_entitlement_for_activation/,
        rows: [
          {
            operationId: OPERATION_ID,
            tenantId: TENANT_ID,
            reservationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            entitlementId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            entitlementVersion: 1,
            activationState: 'RESERVED',
            effectiveAt: new Date('2026-08-25T12:00:00.000Z'),
            capacityEnvelopeVersion: 7,
            sustainedIngressMessagesPerSecond: 10,
            sustainedMetricRowsPerMinute: 100,
          },
        ],
      },
      {
        matcher: /telemetry_activation_prerequisites/,
        rows: [{ hypertableReady: true, caggCount: 3 }],
      },
      { matcher: /supersede_previous_active_entitlement/, rows: [] },
      { matcher: /INSERT INTO admin\.telemetry_capacity_activation_events/, rows: [] },
    ]);
    transaction.mockImplementationOnce(
      async (_isolation: string, work: (manager: EntityManager) => Promise<unknown>) =>
        work(activationManager),
    );

    const result = await service.activate(OPERATION_ID, TENANT_ID);

    expect(result.activationState).toBe('ACTIVE');
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        activationState: 'ACTIVE',
        effectiveAt: '2026-08-25T12:00:00.000Z',
        capacityEnvelopeVersion: 7,
      }),
      activationManager,
      expect.objectContaining({
        idempotencyKey: `telemetry-capacity:${OPERATION_ID}:ACTIVE`,
      }),
    );
  });

  it('versions capacity envelopes while holding the active envelope lock', async () => {
    const envelopeManager = managerWith([
      {
        matcher: /capacity_envelope_for_revision[\s\S]+FOR UPDATE/,
        rows: [{ version: 7 }],
      },
      { matcher: /SUPERSEDED[\s\S]+telemetry_capacity_envelopes/, rows: [] },
      {
        matcher: /INSERT INTO admin\.telemetry_capacity_envelopes/,
        rows: [
          {
            id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            version: 8,
            sustainedIngressMessagesPerSecond: 2_000,
            sustainedMetricRowsPerMinute: 120_000,
            effectiveAt: new Date('2026-09-01T00:00:00.000Z'),
          },
        ],
      },
      {
        matcher: /promote_pending_capacity_entitlements/,
        rows: [
          {
            operationId: OPERATION_ID,
            tenantId: TENANT_ID,
            reservationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            entitlementId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            entitlementVersion: 1,
            activationState: 'RESERVED',
            effectiveAt: new Date('2026-09-01T00:00:00.000Z'),
            capacityEnvelopeVersion: 7,
            sustainedIngressMessagesPerSecond: 10,
            sustainedMetricRowsPerMinute: 100,
          },
        ],
      },
      { matcher: /release_capacity_blocked_provisioning_runs/, rows: [] },
    ]);
    transaction.mockImplementationOnce(
      async (_isolation: string, work: (manager: EntityManager) => Promise<unknown>) =>
        work(envelopeManager),
    );

    const result = await service.createEnvelope({
      sustainedIngressMessagesPerSecond: 2_000,
      sustainedMetricRowsPerMinute: 120_000,
      effectiveAt: new Date('2026-09-01T00:00:00.000Z'),
      createdBy: 'platform-admin-1',
    });

    expect(result.version).toBe(8);
    expect(transaction).toHaveBeenCalledWith('SERIALIZABLE', expect.any(Function));
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ activationState: 'RESERVED' }),
      envelopeManager,
      expect.objectContaining({
        idempotencyKey: `telemetry-capacity:${OPERATION_ID}:RESERVED`,
      }),
    );
  });

  it('releases an active revision and atomically restores the previous active entitlement', async () => {
    const releaseManager = managerWith([
      {
        matcher: /capacity_envelope_for_release[\s\S]+FOR UPDATE/,
        rows: [
          {
            id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            version: 7,
            ingressLimit: 100,
            rowLimit: 1_000,
          },
        ],
      },
      {
        matcher: /capacity_entitlement_for_release/,
        rows: [
          {
            operationId: OPERATION_ID,
            tenantId: TENANT_ID,
            reservationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            entitlementId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            entitlementVersion: 2,
            activationState: 'ACTIVE',
            effectiveAt: new Date('2026-08-25T12:00:00.000Z'),
            capacityEnvelopeVersion: 7,
            sustainedIngressMessagesPerSecond: 20,
            sustainedMetricRowsPerMinute: 200,
          },
        ],
      },
      {
        matcher: /previous_capacity_entitlement_for_restore/,
        rows: [
          {
            operationId: '33333333-3333-4333-8333-333333333333',
            tenantId: TENANT_ID,
            reservationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            entitlementId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
            entitlementVersion: 1,
            activationState: 'SUPERSEDED',
            effectiveAt: new Date('2026-08-20T12:00:00.000Z'),
            capacityEnvelopeVersion: 6,
            sustainedIngressMessagesPerSecond: 10,
            sustainedMetricRowsPerMinute: 100,
          },
        ],
      },
      {
        matcher: /capacity_commitments_after_release/,
        rows: [{ ingress: '80', rows: '800' }],
      },
      { matcher: /append_released_capacity_entitlement/, rows: [] },
      { matcher: /restore_previous_active_capacity_entitlement/, rows: [] },
      { matcher: /cancel_released_capacity_provisioning_run/, rows: [] },
      { matcher: /promote_pending_capacity_entitlements/, rows: [] },
      { matcher: /release_capacity_blocked_provisioning_runs/, rows: [] },
    ]);
    transaction.mockImplementationOnce(
      async (_isolation: string, work: (manager: EntityManager) => Promise<unknown>) =>
        work(releaseManager),
    );

    const result = await service.release(OPERATION_ID, TENANT_ID);

    expect(result.activationState).toBe('RELEASED');
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        entitlementId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        activationState: 'RELEASED',
      }),
      releaseManager,
      expect.objectContaining({
        idempotencyKey: `telemetry-capacity:${OPERATION_ID}:RELEASED`,
      }),
    );
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        entitlementId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        activationState: 'ACTIVE',
        effectiveAt: '2026-08-20T12:00:00.000Z',
        capacityEnvelopeVersion: 6,
      }),
      releaseManager,
      expect.objectContaining({
        idempotencyKey: 'telemetry-capacity:33333333-3333-4333-8333-333333333333:RESTORED',
      }),
    );
  });
});
