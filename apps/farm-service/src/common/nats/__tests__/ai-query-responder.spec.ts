import { isoOrNull, numberOrNull, toBoundedList } from '../ai-query-responder';

/**
 * Projection helpers of the farm AI read responders. The responder skeleton
 * is covered where it lives: libs/backend-common/src/nats/__tests__/tenant-bound-reply.spec.ts.
 */
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
