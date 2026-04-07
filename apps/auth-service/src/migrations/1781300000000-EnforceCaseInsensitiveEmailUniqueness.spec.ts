import type { QueryRunner } from 'typeorm';
import { EnforceCaseInsensitiveEmailUniqueness1781300000000 } from './1781300000000-EnforceCaseInsensitiveEmailUniqueness';

/**
 * EnforceCaseInsensitiveEmailUniqueness.spec.ts
 * ============================================================================
 *
 * Behavioural test for the email uniqueness migration. The key paths to
 * cover:
 *
 *   1. No duplicates → DROP old index → CREATE new index (happy path)
 *   2. Duplicates exist → abort with actionable error BEFORE any DDL
 *   3. down() with no duplicates → DROP new → CREATE old
 *   4. down() with duplicates → abort to avoid a late generic error
 *
 * The pre-check behaviour is the security-sensitive part: a silent
 * no-op on duplicate data would let the migration succeed while
 * leaving the schema in a half-converted state. We therefore assert
 * that the pre-check query runs FIRST and that no DDL is issued when
 * it returns rows.
 */

/**
 * Minimal mock QueryRunner with scripted replies (FIFO) and a recorded
 * call log. Same helper shape as apply-tenant-rls.helper.spec.ts but
 * duplicated here to avoid cross-package test dependencies.
 */
function makeMockRunner(replies: ReadonlyArray<unknown>): {
  runner: QueryRunner;
  calls: Array<{ sql: string; params?: unknown[] }>;
} {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  let idx = 0;
  const runner = {
    query: async (sql: string, params?: unknown[]): Promise<unknown> => {
      calls.push({ sql, params });
      if (idx >= replies.length) {
        throw new Error(
          `mock runner exhausted at call ${idx}: unexpected SQL "${sql.slice(
            0,
            80,
          )}..."`,
        );
      }
      return replies[idx++];
    },
  } as unknown as QueryRunner;
  return { runner, calls };
}

describe('EnforceCaseInsensitiveEmailUniqueness1781300000000', () => {
  let migration: EnforceCaseInsensitiveEmailUniqueness1781300000000;

  beforeEach(() => {
    migration = new EnforceCaseInsensitiveEmailUniqueness1781300000000();
  });

  describe('up()', () => {
    it('drops legacy index and creates LOWER(email) unique expression index when no duplicates', async () => {
      const replies = [
        [], // pre-check: no duplicates
        undefined, // DROP INDEX
        undefined, // CREATE INDEX
      ];
      const { runner, calls } = makeMockRunner(replies);

      await migration.up(runner);

      expect(calls.length).toBe(3);

      // Call 0: the pre-check MUST be the first query issued.
      // Critical: if DDL runs before the pre-check, we lose the
      // "abort cleanly" guarantee.
      expect(calls[0]?.sql).toMatch(/GROUP BY LOWER\("email"\)/);
      expect(calls[0]?.sql).toMatch(/HAVING COUNT\(\*\) > 1/);

      // Call 1: DROP legacy index
      expect(calls[1]?.sql).toContain('DROP INDEX IF EXISTS "IDX_users_email"');

      // Call 2: CREATE new expression index
      expect(calls[2]?.sql).toContain(
        'CREATE UNIQUE INDEX IF NOT EXISTS "users_email_lower_key"',
      );
      expect(calls[2]?.sql).toContain('(LOWER("email"))');
    });

    it('aborts WITHOUT issuing any DDL when case-insensitive duplicates exist', async () => {
      const replies = [
        [
          { lowered: 'duplicate@example.com', count: '2' },
          { lowered: 'another@example.com', count: '3' },
        ],
      ];
      const { runner, calls } = makeMockRunner(replies);

      await expect(migration.up(runner)).rejects.toThrow(
        /Refusing to install case-insensitive unique index/,
      );

      // Critical guarantee: ONLY the pre-check ran. No DROP, no CREATE.
      expect(calls.length).toBe(1);
      expect(calls[0]?.sql).toContain('HAVING COUNT(*) > 1');
    });

    it('error message names the affected addresses and row counts', async () => {
      const replies = [
        [
          { lowered: 'a@x.com', count: '2' },
          { lowered: 'b@x.com', count: '4' },
        ],
      ];
      const { runner } = makeMockRunner(replies);

      await expect(migration.up(runner)).rejects.toThrow(/a@x\.com/);
      // Reset state and re-run (rejected promise consumes the mock once)
      const replies2 = [
        [
          { lowered: 'a@x.com', count: '2' },
          { lowered: 'b@x.com', count: '4' },
        ],
      ];
      const { runner: runner2 } = makeMockRunner(replies2);
      await expect(migration.up(runner2)).rejects.toThrow(/b@x\.com/);
    });

    it('caps the duplicate list at 10 in the error message', async () => {
      // Twelve duplicates — the message should only enumerate the top
      // 10 and mention "... and 2 more".
      const replies = [
        Array.from({ length: 12 }, (_, i) => ({
          lowered: `dup${i}@x.com`,
          count: '2',
        })),
      ];
      const { runner } = makeMockRunner(replies);

      await expect(migration.up(runner)).rejects.toThrow(/\.\.\. and 2 more/);
    });
  });

  describe('down()', () => {
    it('re-installs legacy case-sensitive index when no exact duplicates exist', async () => {
      const replies = [
        [], // pre-check: no exact duplicates
        undefined, // DROP new index
        undefined, // CREATE legacy index
      ];
      const { runner, calls } = makeMockRunner(replies);

      await migration.down(runner);

      expect(calls[0]?.sql).toMatch(/GROUP BY "email"/);
      expect(calls[1]?.sql).toContain('DROP INDEX IF EXISTS "users_email_lower_key"');
      expect(calls[2]?.sql).toContain(
        'CREATE UNIQUE INDEX IF NOT EXISTS "IDX_users_email"',
      );
    });

    it('aborts down() if exact-match duplicates appeared after up() was applied', async () => {
      // Scenario: up() ran successfully some time ago, users inserted
      // rows with case-variant duplicates that only violate the
      // case-sensitive constraint. A naive down() would fail partway
      // through CREATE UNIQUE INDEX. The migration catches this
      // upfront.
      const replies = [
        [{ email: 'x@y.com', count: '2' }],
      ];
      const { runner } = makeMockRunner(replies);

      await expect(migration.down(runner)).rejects.toThrow(
        /Refusing to install case-sensitive unique index on rollback/,
      );
    });
  });
});
