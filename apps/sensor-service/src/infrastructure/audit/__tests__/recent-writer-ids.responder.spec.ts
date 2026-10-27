import 'reflect-metadata';

const mockRunInTenantRead = jest.fn();
jest.mock('@aquaculture/backend-common/database', () => ({
  ...jest.requireActual('@aquaculture/backend-common/database'),
  runInTenantRead: (...args: unknown[]): unknown => mockRunInTenantRead(...args),
}));

import { createMockDataSource } from '@aquaculture/testing';
import { Test } from '@nestjs/testing';
import { NatsRequestReply } from '@platform/event-bus';
import {
  MODULE_ACTIVITY_QUERY_SUBJECTS,
  type RecentWriterIdsRequest,
} from '@platform/event-contracts';
import { DataSource } from 'typeorm';

import { SensorRecentWriterIdsResponder } from '../recent-writer-ids.responder';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER_A = '22222222-2222-4222-8222-222222222222';
const USER_B = '33333333-3333-4333-8333-333333333333';

const request: RecentWriterIdsRequest = {
  caller: { kind: 'service', service: 'auth_service' },
  tenantId: TENANT,
  userIds: [USER_A, USER_B],
  windowDays: 30,
};

/**
 * request.sensor.recentWriterIds (PKG-06 readiness): sensor answers how many of the members auth
 * names changed an audited sensor record (sensors, devices, PLC connections, programs ...) in
 * the window, from sensor's own audit trail. A count only, for auth_service only.
 */
describe('SensorRecentWriterIdsResponder', () => {
  const drain = jest.fn().mockResolvedValue(undefined);
  const respond = jest.fn().mockResolvedValue({ drain });
  let responder: SensorRecentWriterIdsResponder;

  beforeEach(async () => {
    jest.clearAllMocks();
    const { mockDataSource } = createMockDataSource();
    const module = await Test.createTestingModule({
      providers: [
        SensorRecentWriterIdsResponder,
        { provide: DataSource, useValue: mockDataSource },
        { provide: NatsRequestReply, useValue: { respond } },
      ],
    }).compile();
    responder = module.get(SensorRecentWriterIdsResponder);
  });

  it("registers sensor's subject in sensor's queue group and drains it", async () => {
    await responder.onModuleInit();
    expect(respond).toHaveBeenCalledWith(
      MODULE_ACTIVITY_QUERY_SUBJECTS.sensor,
      expect.any(Function),
      { queue: 'sensor-service' },
    );

    await responder.onModuleDestroy();
    expect(drain).toHaveBeenCalledTimes(1);
  });

  it("counts the distinct actors among the asked ids in sensor's audit trail", async () => {
    const query = jest.fn().mockResolvedValue([{ writers: 2 }]);
    mockRunInTenantRead.mockImplementation(
      (
        _dataSource: unknown,
        schema: string,
        tenantId: string,
        read: (runner: unknown) => Promise<unknown>,
      ) => {
        expect(schema).toBe('sensor');
        expect(tenantId).toBe(TENANT);
        return read({ query });
      },
    );

    await expect(responder.answer(request)).resolves.toEqual({
      ok: true,
      data: { recentWriterCount: 2 },
    });
    const [sql, parameters] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('FROM sensor.sensor_audit_logs');
    expect(sql).toContain('count(DISTINCT changed_by)');
    expect(parameters).toEqual([TENANT, [USER_A, USER_B], 30]);
  });

  it('answers a malformed request INVALID_REQUEST without reading', async () => {
    await expect(responder.answer({ tenantId: TENANT })).resolves.toEqual({
      ok: false,
      error: 'INVALID_REQUEST',
    });
    expect(mockRunInTenantRead).not.toHaveBeenCalled();
  });
});
