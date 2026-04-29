/**
 * Platform-wide invariant — DATA-LOW-001:
 *
 * `dataSource.driver as any` (or `as unknown as ...` casts to access
 * TypeORM driver internals) MUST go through the canonical
 * `getPgPoolFromDataSource()` helper at
 * `libs/backend-common/src/database/pg-pool-from-data-source.util.ts`.
 *
 * # Why this lives in tests/invariants/
 *
 * Pre-cure two services bypassed TypeORM's typed driver surface
 * with inline `as any` casts to grab the underlying pg.Pool. The
 * `as any` is a CLAUDE.md violation but inevitable at the boundary
 * — TypeORM's `Driver` interface doesn't expose `master`. The
 * architectural cure is to centralize the cast in ONE typed
 * adapter.
 *
 * This invariant prevents the regression class: ANY new
 * `dataSource.driver as ...` cast outside the adapter file
 * trips at PR review.
 *
 * # What this spec asserts
 *
 *   1. The adapter file exists and exports `getPgPoolFromDataSource`.
 *   2. NO file under `apps/**` or `libs/**` (except the adapter
 *      itself) contains a `dataSource.driver as` pattern.
 *   3. The two known consumers (TenantConnectionBootstrap +
 *      RlsConnectionBootstrap) import the adapter (positive
 *      assertion to catch import-removal regressions).
 *
 * Closes: docs/reviews/data-expert/2026-04-28-core-platform-review.md#DATA-LOW-001
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const ADAPTER_PATH =
  'libs/backend-common/src/database/pg-pool-from-data-source.util.ts';

function read(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf8');
}

describe('DATA-LOW-001 — no inline dataSource.driver cast outside the adapter', () => {
  it('the canonical adapter exists at the expected path', () => {
    const src = read(ADAPTER_PATH);
    expect(src).toMatch(/export\s+function\s+getPgPoolFromDataSource\b/);
    expect(src).toMatch(/export\s+interface\s+PgPoolLike\b/);
  });

  it('every consumer imports getPgPoolFromDataSource', () => {
    const consumers = [
      'libs/backend-common/src/database/tenant-connection-bootstrap.service.ts',
      'libs/backend-common/src/database/rls/rls-connection-bootstrap.service.ts',
    ];
    for (const path of consumers) {
      const src = read(path);
      expect(src).toMatch(
        /import\s*{[^}]*getPgPoolFromDataSource[^}]*}\s*from\s*['"][^'"]*pg-pool-from-data-source[^'"]*['"]/,
      );
    }
  });

  it('no file outside the adapter contains `dataSource.driver as` (cast pattern)', () => {
    let hits: string;
    try {
      // The regex matches the actual code shape:
      //   `const x = this.dataSource.driver as ...`
      //   `const x = dataSource.driver as ...`
      // and EXCLUDES backtick-quoted matches inside comments
      // (the cure-comment in tenant-connection-bootstrap.service.ts
      // contains the pattern verbatim as documentation).
      hits = execFileSync(
        'git',
        [
          'grep',
          '-l',
          '-E',
          '^[^/`]*[^.\\w]dataSource\\.driver\\s+as\\s+[a-zA-Z]',
          '--',
          'apps/',
          'libs/',
          ':!**/*.spec.ts',
          ':!**/*.test.ts',
          ':!**/__tests__/**',
          // Exclude the adapter itself — it's where the cast
          // legitimately lives.
          ':!libs/backend-common/src/database/pg-pool-from-data-source.util.ts',
        ],
        { cwd: REPO_ROOT, encoding: 'utf8' },
      );
    } catch (err: unknown) {
      // git grep exits 1 when no matches — that's the green path.
      const e = err as { status?: number; stdout?: string };
      if (e.status === 1) {
        hits = '';
      } else {
        throw err;
      }
    }
    const matched = hits.split('\n').filter((line) => line.length > 0);
    expect(matched).toEqual([]);
  });
});
