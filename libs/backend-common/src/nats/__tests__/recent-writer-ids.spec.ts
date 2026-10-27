import { Logger } from '@nestjs/common';
import type { RecentWriterIdsRequest } from '@platform/event-contracts';

import { answerRecentWriterIds, readWriterCount } from '../recent-writer-ids';

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
 * and decide the caller before the module counts anything, and answer a count no larger than the
 * ids asked about. A failed read is INTERNAL_ERROR, logged without ids.
 */
describe('answerRecentWriterIds', () => {
  let error: jest.SpyInstance;

  beforeEach(() => {
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  it("hands the admitted request to the module's count and answers the count", async () => {
    const count = jest.fn().mockResolvedValue(1);

    await expect(answerRecentWriterIds('farm', request, count)).resolves.toEqual({
      ok: true,
      data: { recentWriterCount: 1 },
    });
    expect(count).toHaveBeenCalledWith(request);
  });

  it('answers a malformed request INVALID_REQUEST without counting', async () => {
    const count = jest.fn();

    await expect(
      answerRecentWriterIds('farm', { ...request, userIds: [] }, count),
    ).resolves.toEqual({ ok: false, error: 'INVALID_REQUEST' });
    expect(count).not.toHaveBeenCalled();
  });

  it('answers a service that is no declared sender FORBIDDEN without counting', async () => {
    const count = jest.fn();

    await expect(
      answerRecentWriterIds(
        'farm',
        { ...request, caller: { kind: 'service', service: 'messaging_service' } },
        count,
      ),
    ).resolves.toEqual({ ok: false, error: 'FORBIDDEN' });
    expect(count).not.toHaveBeenCalled();
  });

  it('answers a failed read INTERNAL_ERROR and logs no id', async () => {
    const count = jest.fn().mockRejectedValue(new TypeError('connection refused'));

    await expect(answerRecentWriterIds('farm', request, count)).resolves.toEqual({
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
    const count = jest.fn().mockResolvedValue(counted);

    await expect(answerRecentWriterIds('farm', request, count)).resolves.toEqual({
      ok: false,
      error: 'INTERNAL_ERROR',
    });
  });

  it('reads the integer writers column of the one row a counting query returns', () => {
    expect(readWriterCount([{ writers: 4 }])).toBe(4);
    expect(() => readWriterCount([])).toThrow(TypeError);
    expect(() => readWriterCount([{ writers: '4' }])).toThrow(TypeError);
  });
});
