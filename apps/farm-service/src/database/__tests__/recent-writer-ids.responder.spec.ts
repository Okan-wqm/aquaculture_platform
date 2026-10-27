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

import { FarmRecentWriterIdsResponder } from '../responders/recent-writer-ids.responder';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER_A = '22222222-2222-4222-8222-222222222222';

const request: RecentWriterIdsRequest = {
  caller: { kind: 'service', service: 'auth_service' },
  tenantId: TENANT,
  userIds: [USER_A],
  windowDays: 90,
};

/**
 * request.farm.recentWriterIds (PKG-06 readiness): farm answers how many of the members auth
 * names wrote to farm in the window, from the actors its audit trail recorded. A count only,
 * read inside the asked tenant, for auth_service only.
 */
describe('FarmRecentWriterIdsResponder', () => {
  const drain = jest.fn().mockResolvedValue(undefined);
  const respond = jest.fn().mockResolvedValue({ drain });
  let responder: FarmRecentWriterIdsResponder;

  beforeEach(async () => {
    jest.clearAllMocks();
    const { mockDataSource } = createMockDataSource();
    const module = await Test.createTestingModule({
      providers: [
        FarmRecentWriterIdsResponder,
        { provide: DataSource, useValue: mockDataSource },
        { provide: NatsRequestReply, useValue: { respond } },
      ],
    }).compile();
    responder = module.get(FarmRecentWriterIdsResponder);
  });

  it("registers farm's subject in farm's queue group and drains it", async () => {
    await responder.onModuleInit();
    expect(respond).toHaveBeenCalledWith(
      MODULE_ACTIVITY_QUERY_SUBJECTS.farm,
      expect.any(Function),
      { queue: 'farm-service' },
    );

    await responder.onModuleDestroy();
    expect(drain).toHaveBeenCalledTimes(1);
  });

  it("counts the distinct audited writers among the asked ids in farm's audit trail", async () => {
    const query = jest.fn().mockResolvedValue([{ writers: 1 }]);
    mockRunInTenantRead.mockImplementation(
      (
        _dataSource: unknown,
        schema: string,
        tenantId: string,
        read: (runner: unknown) => Promise<unknown>,
      ) => {
        expect(schema).toBe('farm');
        expect(tenantId).toBe(TENANT);
        return read({ query });
      },
    );

    await expect(responder.answer(request)).resolves.toEqual({
      ok: true,
      data: { recentWriterCount: 1 },
    });
    const [sql, parameters] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('FROM farm.farm_audit_logs');
    expect(sql).toContain('count(DISTINCT "userId")');
    expect(sql).toContain(`"action" <> 'SUPER_ADMIN_CROSS_TENANT_ACCESS'`);
    expect(parameters).toEqual([TENANT, [USER_A], 90]);
  });

  it('answers another service FORBIDDEN without reading', async () => {
    await expect(
      responder.answer({ ...request, caller: { kind: 'service', service: 'hr_service' } }),
    ).resolves.toEqual({ ok: false, error: 'FORBIDDEN' });
    expect(mockRunInTenantRead).not.toHaveBeenCalled();
  });
});
