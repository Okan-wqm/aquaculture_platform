/**
 * INFRA-CRITICAL-012 invariant: messaging partition child creation has one
 * runtime path.
 *
 * The old E2E fixture created monthly partition children with a
 * `<table>_y<year>m<month>` naming convention before the app started. The
 * runtime manager then created `<table>_<year>_<month>` for the same ranges,
 * and PostgreSQL rejected the overlap. The architectural contract is:
 *
 *   - tests may clone partitioned parent tables, but must not create child
 *     partitions;
 *   - messaging runtime code must not expose raw `PARTITION OF` creation
 *     helpers;
 *   - PartitionManagerService is the only runtime orchestrator and delegates
 *     the DDL authority to `platform.create_messaging_partition`.
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const E2E_SETUP = 'apps/messaging-service/test/e2e-setup.ts';
const PARTITION_MANAGER = 'apps/messaging-service/src/partition/partition-manager.service.ts';
const PARTITION_QUERIES = 'apps/messaging-service/src/partition/partition-queries.ts';

function read(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf8');
}

function executableSource(path: string): string {
  return read(path)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

function gitFiles(paths: string[]): string[] {
  return execSync(`git -C ${REPO_ROOT} ls-files -- ${paths.join(' ')}`, {
    encoding: 'utf8',
  })
    .split(/\r?\n/)
    .filter(Boolean);
}

describe('INVARIANT — INFRA-CRITICAL-012 partition creation SSoT', () => {
  it('keeps the messaging E2E tenant fixture partition-child free', () => {
    const source = executableSource(E2E_SETUP);

    expect(source).toContain('PartitionManagerService');
    expect(source).toContain(
      'new PartitionManagerService(dataSource).onApplicationBootstrap()',
    );
    expect(source).not.toMatch(/\bPARTITION\s+OF\b/);
    expect(source).not.toMatch(/\bFOR\s+VALUES\s+FROM\b/);
    expect(source).not.toMatch(/_y\$\{year\}m\$\{month\}|_y\d{4}m\d{2}/);
  });

  it('keeps raw partition child creation out of messaging runtime/test code', () => {
    const offenders = gitFiles([
      'apps/messaging-service/src',
      'apps/messaging-service/test',
    ])
      .filter((path) => !path.includes('/migrations/'))
      .filter((path) => /\.(ts|sql)$/.test(path))
      .flatMap((path) => {
        const source = executableSource(path);
        return /\bPARTITION\s+OF\b/.test(source) || /\bFOR\s+VALUES\s+FROM\b/.test(source)
          ? [path]
          : [];
      });

    expect(offenders).toEqual([]);
  });

  it('does not expose legacy raw partition creation query builders', () => {
    const source = executableSource(PARTITION_QUERIES);

    expect(source).not.toContain('PARTITION OF');
    expect(source).not.toContain('FOR VALUES FROM');
    expect(source).not.toContain('createMonthlyPartition');
    expect(source).not.toContain('createYearPartitions');
    expect(source).not.toContain('createUpcomingPartitions');
  });

  it('pins the runtime creator to the platform SECURITY DEFINER primitive', () => {
    const source = executableSource(PARTITION_MANAGER);

    expect(source).toContain(
      'SELECT platform.create_messaging_partition($1, $2, $3, $4)',
    );
    expect(source).not.toContain('PARTITION OF');
    expect(source).not.toContain('FOR VALUES FROM');
  });
});
