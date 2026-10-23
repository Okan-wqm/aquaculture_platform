import type { QueryRunner } from 'typeorm';

/**
 * The rows an `UPDATE … RETURNING` or `INSERT … RETURNING` answers. TypeORM's raw
 * `query()` answers an UPDATE as `[rows, count]`, which is not an array of rows; the
 * structured form (`useStructuredResult`) is, so every write that reads its result goes
 * through here.
 */
export async function returningRows<T>(
  qr: QueryRunner,
  sql: string,
  params: readonly unknown[],
): Promise<T[]> {
  const result: { records: T[] } = await qr.query(sql, [...params], true);
  return result.records;
}
