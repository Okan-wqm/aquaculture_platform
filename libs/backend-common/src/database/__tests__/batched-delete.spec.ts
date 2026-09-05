import { batchedDeleteSql, deleteInBatches } from '../batched-delete';

/** ADMIN-HIGH-013 — disposal is bounded per statement and stops when a batch comes back short. */
describe('deleteInBatches', () => {
  it('addresses rows by ctid with the batch size as the trailing parameter', () => {
    expect(
      batchedDeleteSql({
        qualifiedTable: '"admin"."activity_logs"',
        where: '"createdAt" < $1 AND "status" = $2',
        params: ['2026-01-01', 'done'],
      }),
    ).toBe(
      'DELETE FROM "admin"."activity_logs" WHERE ctid = ANY(ARRAY(SELECT ctid FROM "admin"."activity_logs" WHERE "createdAt" < $1 AND "status" = $2 LIMIT $3)) RETURNING 1',
    );
  });

  it('keeps deleting full batches and stops after the first short one', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce(Array.from({ length: 3 }))
      .mockResolvedValueOnce(Array.from({ length: 3 }))
      .mockResolvedValueOnce(Array.from({ length: 1 }));

    const result = await deleteInBatches(
      { query },
      { qualifiedTable: '"s"."t"', where: '"ts" < $1', params: ['x'], batchSize: 3 },
    );

    expect(result).toEqual({ deleted: 7, capped: false });
    expect(query).toHaveBeenCalledTimes(3);
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining('LIMIT $2'), ['x', 3]);
  });

  it('reports a capped run instead of looping forever', async () => {
    const query = jest.fn().mockResolvedValue(Array.from({ length: 2 }));

    const result = await deleteInBatches(
      { query },
      { qualifiedTable: '"s"."t"', where: '"ts" < $1', params: ['x'], batchSize: 2, maxBatches: 4 },
    );

    expect(result).toEqual({ deleted: 8, capped: true });
    expect(query).toHaveBeenCalledTimes(4);
  });
});
