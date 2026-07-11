import type { QueryRunner } from 'typeorm';

import {
  POST_FANOUT_ORPHAN_TYPE_RECLAMATIONS,
  reclaimPostFanoutOrphanTypes,
} from '../orphan-type-reclamation';

/**
 * London-school unit tests for the post-fan-out orphan-type reclamation
 * (FARM-MEDIUM-170). The reclaimer operates on a caller-owned QueryRunner, so a
 * scripted mock lets us assert the drop/defer/absent decision without a live DB.
 * The pg_depend semantics themselves are exercised by the fan-out integration
 * suite in CI; here we pin the decision logic + the DROP-TYPE gate.
 */

interface ScriptedResponse {
  match: (sql: string) => boolean;
  rows: unknown;
}

function mockRunner(responses: ScriptedResponse[]): {
  runner: QueryRunner;
  executed: string[];
} {
  const executed: string[] = [];
  const query = jest.fn((sql: string) => {
    executed.push(sql);
    const hit = responses.find((r) => r.match(sql));
    return Promise.resolve(hit ? hit.rows : []);
  });
  return { runner: { query } as Partial<QueryRunner> as QueryRunner, executed };
}

const TARGET = POST_FANOUT_ORPHAN_TYPE_RECLAMATIONS[0];
if (!TARGET) {
  throw new Error('POST_FANOUT_ORPHAN_TYPE_RECLAMATIONS must not be empty for these tests');
}

describe('reclaimPostFanoutOrphanTypes', () => {
  it('DROPs the shared type when it exists and has zero dependents', async () => {
    const { runner, executed } = mockRunner([
      { match: (s) => s.includes('FROM pg_catalog.pg_type t\n'), rows: [{ n: 1 }] },
      { match: (s) => s.includes('FROM pg_catalog.pg_depend'), rows: [{ n: 0 }] },
    ]);
    const log = jest.fn();

    const results = await reclaimPostFanoutOrphanTypes(runner, log);

    expect(results).toContainEqual({
      schema: TARGET.schema,
      typeName: TARGET.typeName,
      outcome: 'dropped',
      dependents: 0,
    });
    expect(executed).toContainEqual(
      `DROP TYPE IF EXISTS "${TARGET.schema}"."${TARGET.typeName}"`,
    );
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Post-fan-out orphan type reclaimed' }),
    );
  });

  it('DEFERS (never drops) while a dependent column remains', async () => {
    const { runner, executed } = mockRunner([
      { match: (s) => s.includes('FROM pg_catalog.pg_type t\n'), rows: [{ n: 1 }] },
      { match: (s) => s.includes('FROM pg_catalog.pg_depend'), rows: [{ n: 3 }] },
    ]);
    const log = jest.fn();

    const results = await reclaimPostFanoutOrphanTypes(runner, log);

    expect(results[0]).toMatchObject({ outcome: 'deferred_still_referenced', dependents: 3 });
    expect(executed.some((s) => s.startsWith('DROP TYPE'))).toBe(false);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'warn' }),
    );
  });

  it('no-ops when the type is already absent (idempotent re-run)', async () => {
    const { runner, executed } = mockRunner([
      { match: (s) => s.includes('FROM pg_catalog.pg_type t\n'), rows: [{ n: 0 }] },
    ]);
    const log = jest.fn();

    const results = await reclaimPostFanoutOrphanTypes(runner, log);

    expect(results[0]).toMatchObject({ outcome: 'absent' });
    expect(executed.some((s) => s.startsWith('DROP TYPE'))).toBe(false);
    // The dependent probe is never even run once the type is gone.
    expect(executed.some((s) => s.includes('FROM pg_catalog.pg_depend'))).toBe(false);
  });

  it('bounds the DROP TYPE lock wait (session lock_timeout/statement_timeout)', async () => {
    const { runner, executed } = mockRunner([
      { match: (s) => s.includes('FROM pg_catalog.pg_type t\n'), rows: [{ n: 1 }] },
      { match: (s) => s.includes('FROM pg_catalog.pg_depend'), rows: [{ n: 0 }] },
    ]);

    await reclaimPostFanoutOrphanTypes(runner, jest.fn());

    expect(executed).toContain(`SET lock_timeout = '2s'`);
    expect(executed).toContain(`SET statement_timeout = '30s'`);
  });
});

describe('POST_FANOUT_ORPHAN_TYPE_RECLAMATIONS SSoT', () => {
  it('carries the qualityGrade orphan reclamation left by migration 1804400', () => {
    const entry = POST_FANOUT_ORPHAN_TYPE_RECLAMATIONS.find(
      (r) => r.typeName === 'harvest_records_qualitygrade_enum',
    );
    expect(entry).toBeDefined();
    expect(entry?.schema).toBe('farm');
    expect(entry?.deferredByMigration).toBe('DropOrphanQualityGradeEnum1804400000000');
  });

  it('uses only safe identifiers (interpolated into DROP TYPE)', () => {
    const safe = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
    for (const entry of POST_FANOUT_ORPHAN_TYPE_RECLAMATIONS) {
      expect(entry.schema).toMatch(safe);
      expect(entry.typeName).toMatch(safe);
    }
  });
});
