import { updateReturningRows } from '../update-returning.util';

describe('updateReturningRows (ORPHAN-HIGH-318 regression pin)', () => {
  it('returns the rows array from the postgres [rows, affected] tuple', () => {
    const rows = updateReturningRows<{ failedLoginAttempts: number; lockedUntil: Date | null }>([
      [{ failedLoginAttempts: 5, lockedUntil: new Date('2026-07-02T12:29:52Z') }],
      1,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.failedLoginAttempts).toBe(5);
  });

  it('returns an empty rows array when the UPDATE matched nothing', () => {
    expect(updateReturningRows<{ id: string }>([[], 0])).toEqual([]);
  });

  it('rejects a plain rows array (SELECT shape) — the exact misread that shipped', () => {
    // ORPHAN-HIGH-318: the old code read result[0] off THIS shape assumption
    // while the driver returned the tuple. Feeding the assumed shape must
    // fail loudly, never silently yield undefined fields.
    expect(() => updateReturningRows([{ failedLoginAttempts: 5 }])).toThrow(
      /expected the TypeORM postgres/,
    );
  });

  it('rejects non-array and malformed tuples', () => {
    expect(() => updateReturningRows(undefined)).toThrow(/Got: undefined/);
    expect(() => updateReturningRows({ rows: [] })).toThrow(/Got: object/);
    expect(() => updateReturningRows([[], '1'])).toThrow(/expected the TypeORM postgres/);
    expect(() => updateReturningRows(['rows', 1])).toThrow(/expected the TypeORM postgres/);
  });
});
