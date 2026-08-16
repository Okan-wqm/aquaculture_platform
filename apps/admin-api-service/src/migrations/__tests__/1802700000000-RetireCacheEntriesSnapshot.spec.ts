import type { QueryRunner } from 'typeorm';

import { RetireCacheEntriesSnapshot1802700000000 } from '../1802700000000-RetireCacheEntriesSnapshot';

describe('RetireCacheEntriesSnapshot1802700000000', () => {
  it('preserves historical rows under an explicitly retired identity', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const migration = new RetireCacheEntriesSnapshot1802700000000();

    await migration.up({ query } as Pick<QueryRunner, 'query'> as QueryRunner);

    const sql = query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).toContain("to_regclass('admin.cache_entries_snapshot')");
    expect(sql).toContain("to_regclass('admin.retired_cache_entries_snapshot')");
    expect(sql).toContain('RENAME TO "retired_cache_entries_snapshot"');
    expect(sql).toContain('never current Redis authority');
    expect(sql).not.toContain('DROP TABLE');
    expect(sql).not.toContain('DELETE FROM');
  });

  it('refuses to reactivate the duplicate snapshot authority', async () => {
    const migration = new RetireCacheEntriesSnapshot1802700000000();

    await expect(migration.down()).rejects.toThrow(
      'cannot be restored as an active cache authority',
    );
  });
});
