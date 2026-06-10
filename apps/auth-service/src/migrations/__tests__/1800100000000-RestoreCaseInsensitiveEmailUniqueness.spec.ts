import type { QueryRunner } from 'typeorm';

import { RestoreCaseInsensitiveEmailUniqueness1800100000000 } from '../1800100000000-RestoreCaseInsensitiveEmailUniqueness';

/**
 * RestoreCaseInsensitiveEmailUniqueness.spec.ts
 * ============================================================================
 *
 * Behavioural test for the email uniqueness restore migration (successor of
 * the archived EnforceCaseInsensitiveEmailUniqueness — the Baseline
 * consolidation dropped the index entirely; this migration re-installs it).
 * The key paths to cover:
 *
 *   1. No duplicates → DROP stray legacy index → CREATE LOWER(email) index
 *   2. Duplicates exist → abort with actionable error BEFORE any DDL
 *   3. down() → drops the expression index only (returns to Baseline state;
 *      no constraint is installed on rollback, so no pre-check is needed)
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
    query: (sql: string, params?: unknown[]): Promise<unknown> => {
      calls.push({ sql, params });
      if (idx >= replies.length) {
        return Promise.reject(
          new Error(
            `mock runner exhausted at call ${idx}: unexpected SQL "${sql.slice(
              0,
              80,
            )}..."`,
          ),
        );
      }
      return Promise.resolve(replies[idx++]);
    },
  } as unknown as QueryRunner;
  return { runner, calls };
}

describe('RestoreCaseInsensitiveEmailUniqueness1800100000000', () => {
  let migration: RestoreCaseInsensitiveEmailUniqueness1800100000000;

  beforeEach(() => {
    migration = new RestoreCaseInsensitiveEmailUniqueness1800100000000();
  });

  describe('up()', () => {
    it('drops stray legacy index and creates LOWER(email) unique expression index when no duplicates', async () => {
      const replies = [
        [], // pre-check: no duplicates
        undefined, // DROP INDEX (stray legacy)
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
      expect(calls[0]?.sql).toContain('"auth"."users"');

      // Call 1: DROP stray legacy index (idempotent no-op on Baseline DBs)
      expect(calls[1]?.sql).toContain('DROP INDEX IF EXISTS "auth"."IDX_users_email"');

      // Call 2: CREATE new expression index
      expect(calls[2]?.sql).toContain(
        'CREATE UNIQUE INDEX IF NOT EXISTS "users_email_lower_key"',
      );
      expect(calls[2]?.sql).toContain('(LOWER("email"))');
      expect(calls[2]?.sql).toContain('"auth"."users"');
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
    it('drops the expression index only — returns to Baseline state without installing any constraint', async () => {
      const replies = [
        undefined, // DROP new index
      ];
      const { runner, calls } = makeMockRunner(replies);

      await migration.down(runner);

      // WHY only one call: rollback must not CREATE a constraint (Baseline
      // never had one, and installing an index on rollback could itself
      // fail on accumulated data). Down is a pure drop.
      expect(calls.length).toBe(1);
      expect(calls[0]?.sql).toContain(
        'DROP INDEX IF EXISTS "auth"."users_email_lower_key"',
      );
    });
  });
});
