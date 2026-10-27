import 'reflect-metadata';

const mockRunInTenantRead = jest.fn();
jest.mock('@aquaculture/backend-common/database', () => ({
  ...jest.requireActual('@aquaculture/backend-common/database'),
  runInTenantRead: (...args: unknown[]): unknown => mockRunInTenantRead(...args),
}));

import { AuditLog } from '@aquaculture/backend-common/decorators';
import { createMockDataSource } from '@aquaculture/testing';
import { Injectable, Logger } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { NatsRequestReply } from '@platform/event-bus';
import {
  MODULE_ACTIVITY_QUERY_SUBJECTS,
  type RecentWriterIdsRequest,
} from '@platform/event-contracts';
import { DataSource } from 'typeorm';

import { HrRecentWriterIdsResponder } from '../recent-writer-ids.responder';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER_A = '22222222-2222-4222-8222-222222222222';

const request: RecentWriterIdsRequest = {
  caller: { kind: 'service', service: 'auth_service' },
  tenantId: TENANT,
  userIds: [USER_A],
  windowDays: 90,
};

/** Two audited hr mutations and an unaudited one, as hr's resolvers declare them. */
@Injectable()
class AuditedHrResolver {
  @AuditLog({ action: 'CREATE_PAYROLL', resource: 'Payroll' })
  createPayroll(): void {
    return undefined;
  }

  @AuditLog({ action: 'UPDATE_EMPLOYEE', resource: 'Employee' })
  updateEmployee(): void {
    return undefined;
  }

  @AuditLog({ action: 'APPROVE_PAYROLL', resource: 'Payroll' })
  approvePayroll(): void {
    return undefined;
  }

  listEmployees(): void {
    return undefined;
  }
}

async function compile(
  extraProviders: readonly (typeof AuditedHrResolver)[],
): Promise<{ responder: HrRecentWriterIdsResponder; respond: jest.Mock; drain: jest.Mock }> {
  const drain = jest.fn().mockResolvedValue(undefined);
  const respond = jest.fn().mockResolvedValue({ drain });
  const { mockDataSource } = createMockDataSource();
  const module = await Test.createTestingModule({
    imports: [DiscoveryModule],
    providers: [
      HrRecentWriterIdsResponder,
      ...extraProviders,
      { provide: DataSource, useValue: mockDataSource },
      { provide: NatsRequestReply, useValue: { respond } },
    ],
  }).compile();
  return { responder: module.get(HrRecentWriterIdsResponder), respond, drain };
}

/**
 * request.hr.recentWriterIds (PKG-06 readiness): hr answers how many of the members auth names
 * ran an audited hr mutation in the window. hr's writes are audited by @AuditLog into the shared
 * semantic audit stream, which other services write too, so hr counts only the rows whose
 * resource one of its own @AuditLog declarations names — read off the decorators at boot, so a
 * newly audited hr mutation joins without a list to keep in step.
 */
describe('HrRecentWriterIdsResponder', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  it("registers hr's subject in hr's queue group and drains it", async () => {
    const { responder, respond, drain } = await compile([AuditedHrResolver]);

    await responder.onModuleInit();
    expect(respond).toHaveBeenCalledWith(MODULE_ACTIVITY_QUERY_SUBJECTS.hr, expect.any(Function), {
      queue: 'hr-service',
    });

    await responder.onModuleDestroy();
    expect(drain).toHaveBeenCalledTimes(1);
  });

  it("counts the distinct actors of hr's audited resources among the asked ids", async () => {
    const { responder } = await compile([AuditedHrResolver]);
    await responder.onModuleInit();
    const query = jest.fn().mockResolvedValue([{ writers: 1 }]);
    mockRunInTenantRead.mockImplementation(
      (
        _dataSource: unknown,
        schema: string,
        tenantId: string,
        read: (runner: unknown) => Promise<unknown>,
      ) => {
        expect(schema).toBe('hr');
        expect(tenantId).toBe(TENANT);
        return read({ query });
      },
    );

    await expect(responder.answer(request)).resolves.toEqual({
      ok: true,
      data: { recentWriterCount: 1 },
    });
    const [sql, parameters] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('FROM shared.audit_logs');
    expect(sql).toContain('"resource" = ANY($4::text[])');
    expect(parameters).toEqual([TENANT, [USER_A], 90, ['Employee', 'Payroll']]);
  });

  it('answers INTERNAL_ERROR, never a zero, when it found no audited hr mutation', async () => {
    const { responder } = await compile([]);
    await responder.onModuleInit();

    await expect(responder.answer(request)).resolves.toEqual({
      ok: false,
      error: 'INTERNAL_ERROR',
    });
    expect(mockRunInTenantRead).not.toHaveBeenCalled();
  });

  it('answers another service FORBIDDEN without reading', async () => {
    const { responder } = await compile([AuditedHrResolver]);
    await responder.onModuleInit();

    await expect(
      responder.answer({ ...request, caller: { kind: 'service', service: 'farm_service' } }),
    ).resolves.toEqual({ ok: false, error: 'FORBIDDEN' });
    expect(mockRunInTenantRead).not.toHaveBeenCalled();
  });
});
