const mockRunInTenantRead = jest.fn();
jest.mock('../../database/tenant-transaction', () => ({
  ...jest.requireActual('../../database/tenant-transaction'),
  runInTenantRead: (...args: unknown[]): unknown => mockRunInTenantRead(...args),
}));

import { collaborator } from '@aquaculture/testing';
import { Logger } from '@nestjs/common';
import type { RecentWriterIdsRequest } from '@platform/event-contracts';
import type { DataSource, QueryRunner } from 'typeorm';

import { answerRecentWriterIds } from '../recent-writer-ids';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER_A = '22222222-2222-4222-8222-222222222222';
const USER_B = '33333333-3333-4333-8333-333333333333';

const request: RecentWriterIdsRequest = {
  caller: { kind: 'service', service: 'auth_service' },
  tenantId: TENANT,
  userIds: [USER_A, USER_B],
  windowDays: 90,
};

/**
 * The chokepoint every recentWriterIds responder answers through (PKG-06; ADR-051 §3): decode
 * and decide the caller before any read, read inside the asked tenant's boundary, and answer a
 * count no larger than the ids asked about. A failed read is INTERNAL_ERROR, logged without ids.
 */
describe('answerRecentWriterIds', () => {
  const dataSource = collaborator<DataSource>({}, 'DataSource');
  const queryRunner = collaborator<QueryRunner>({}, 'QueryRunner');
  let error: jest.SpyInstance;
  const source = { dataSource, module: 'farm' as const, sourceSchema: 'farm' };

  beforeEach(() => {
    mockRunInTenantRead.mockReset();
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  it('counts inside the asked tenant and answers the count', async () => {
    mockRunInTenantRead.mockImplementation(
      (
        _dataSource: unknown,
        _schema: string,
        _tenantId: string,
        read: (runner: QueryRunner) => Promise<unknown>,
      ) => read(queryRunner),
    );
    const count = jest.fn().mockResolvedValue(1);

    await expect(answerRecentWriterIds(source, request, count)).resolves.toEqual({
      ok: true,
      data: { recentWriterCount: 1 },
    });
    expect(mockRunInTenantRead).toHaveBeenCalledWith(
      dataSource,
      'farm',
      TENANT,
      expect.any(Function),
    );
    expect(count).toHaveBeenCalledWith(queryRunner, request);
  });

  it('answers a malformed request INVALID_REQUEST without reading', async () => {
    const count = jest.fn();

    await expect(
      answerRecentWriterIds(source, { ...request, userIds: [] }, count),
    ).resolves.toEqual({ ok: false, error: 'INVALID_REQUEST' });
    expect(mockRunInTenantRead).not.toHaveBeenCalled();
    expect(count).not.toHaveBeenCalled();
  });

  it('answers a service that is no declared sender FORBIDDEN without reading', async () => {
    const count = jest.fn();

    await expect(
      answerRecentWriterIds(
        source,
        { ...request, caller: { kind: 'service', service: 'messaging_service' } },
        count,
      ),
    ).resolves.toEqual({ ok: false, error: 'FORBIDDEN' });
    expect(mockRunInTenantRead).not.toHaveBeenCalled();
  });

  it('answers a failed read INTERNAL_ERROR and logs no id', async () => {
    mockRunInTenantRead.mockRejectedValue(new TypeError('connection refused'));

    await expect(answerRecentWriterIds(source, request, jest.fn())).resolves.toEqual({
      ok: false,
      error: 'INTERNAL_ERROR',
    });
    const logged = String(error.mock.calls[0]?.[0]);
    expect(JSON.parse(logged)).toEqual({
      event: 'recent_writer_ids_read_failed',
      module: 'farm',
      errorType: 'TypeError',
    });
    expect(logged).not.toContain(TENANT);
    expect(logged).not.toContain(USER_A);
  });

  it.each([
    ['more writers than ids asked about', 3],
    ['a fractional count', 0.5],
    ['a negative count', -1],
  ])('refuses %s as INTERNAL_ERROR', async (_label, counted) => {
    mockRunInTenantRead.mockResolvedValue(counted);

    await expect(answerRecentWriterIds(source, request, jest.fn())).resolves.toEqual({
      ok: false,
      error: 'INTERNAL_ERROR',
    });
  });
});
