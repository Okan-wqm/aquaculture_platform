import { Logger } from '@nestjs/common';
import { getRequestContext } from '@aquaculture/backend-common/logging';
import { FARM_AI_QUERY_SUBJECTS } from '@platform/event-contracts';
import { isoOrNull, numberOrNull, respondAiQuery, toBoundedList } from '../ai-query-responder';

/**
 * The shared responder skeleton for every farm AI read subject
 * (FARM-MEDIUM-328): guard → handle → envelope, never a throw into the reply.
 */
describe('respondAiQuery', () => {
  const logger = new Logger('spec');
  const isReq = (v: unknown): v is { tenantId: string; x: number } =>
    typeof v === 'object' && v !== null && typeof (v as { x?: unknown }).x === 'number';

  beforeEach(() => {
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    jest.spyOn(logger, 'error').mockImplementation(() => undefined);
  });

  it('rejects a payload that fails the contract guard without calling the handler', async () => {
    const handle = jest.fn();
    const reply = await respondAiQuery(
      logger,
      FARM_AI_QUERY_SUBJECTS.FH_STATS,
      { tenantId: 't' },
      isReq,
      handle,
    );
    expect(reply).toEqual({ ok: false, error: 'INVALID_REQUEST' });
    expect(handle).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('runs the handler inside the tenant AsyncLocalStorage frame (ambient repositories resolve the tenant)', async () => {
    const tenantId = '11111111-1111-4111-8111-111111111111';
    expect(getRequestContext().tenantId).toBeUndefined();
    const reply = await respondAiQuery(
      logger,
      FARM_AI_QUERY_SUBJECTS.BATCH_PERFORMANCE,
      { tenantId, x: 1 },
      isReq,
      async () => ({ seenTenant: getRequestContext().tenantId }),
    );
    expect(reply).toEqual({ ok: true, data: { seenTenant: tenantId } });
    expect(getRequestContext().tenantId).toBeUndefined();
  });

  it('wraps the handler result in the ok envelope', async () => {
    const reply = await respondAiQuery(
      logger,
      FARM_AI_QUERY_SUBJECTS.FH_STATS,
      { tenantId: '11111111-1111-4111-8111-111111111111', x: 1 },
      isReq,
      async (req) => ({ doubled: req.x * 2 }),
    );
    expect(reply).toEqual({ ok: true, data: { doubled: 2 } });
  });

  it('turns a handler failure into INTERNAL_ERROR and logs it — never throws into the reply channel', async () => {
    const reply = await respondAiQuery(
      logger,
      FARM_AI_QUERY_SUBJECTS.FH_STATS,
      { tenantId: '11111111-1111-4111-8111-111111111111', x: 1 },
      isReq,
      async () => {
        throw new Error('db down');
      },
    );
    expect(reply).toEqual({ ok: false, error: 'INTERNAL_ERROR' });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('db down'));
  });
});

describe('toBoundedList', () => {
  const rows = Array.from({ length: 7 }, (_, i) => ({ n: i }));

  it('slices to the limit and flags truncation', () => {
    expect(toBoundedList(rows, 5, (r) => r.n)).toEqual({ items: [0, 1, 2, 3, 4], truncated: true });
    expect(toBoundedList(rows, 7, (r) => r.n).truncated).toBe(false);
  });

  it('never exceeds the contract cap even when asked to', () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ n: i }));
    const list = toBoundedList(many, 500, (r) => r.n);
    expect(list.items).toHaveLength(50);
    expect(list.truncated).toBe(true);
  });

  it('forwards a known total and derives truncation from it', () => {
    expect(toBoundedList(rows, 10, (r) => r.n, 120)).toEqual({
      items: [0, 1, 2, 3, 4, 5, 6],
      truncated: true,
      total: 120,
    });
  });
});

describe('scalar projections', () => {
  it('isoOrNull / numberOrNull normalise nullable entity columns', () => {
    expect(isoOrNull(null)).toBeNull();
    expect(isoOrNull(undefined)).toBeNull();
    expect(isoOrNull(new Date('2026-09-18T10:00:00Z'))).toBe('2026-09-18T10:00:00.000Z');
    expect(numberOrNull(undefined)).toBeNull();
    expect(numberOrNull('12.5')).toBe(12.5);
    expect(numberOrNull('abc')).toBeNull();
    expect(numberOrNull(3)).toBe(3);
  });
});
