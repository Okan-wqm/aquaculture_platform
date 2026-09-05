/**
 * INVARIANT — one cross-tenant access authority (ADR-0007, SEC-CRITICAL-057).
 *
 * The impersonation subsystem minted tokens nothing consumed and kept its
 * sessions in a table whose WORM trigger refused every lifecycle write. It
 * was a second, weaker authority beside the kernel act-as middleware
 * (`X-Act-As-Tenant`: UUID + tenant-ACTIVE fail-closed + MFA step-up + HMAC-
 * bound effective tenant). ADR-0007 deletes it; this spec keeps it deleted.
 *
 * Retired identifiers may survive only in migrations (the archive-then-drop
 * record), in archived review documents, and in built `dist/` output — never
 * in source, tests, configuration, or deploy artefacts.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

/** Identifiers that named the deleted subsystem. Not a list of things to keep — a list of things that must stay gone. */
const RETIRED_IDENTIFIERS: ReadonlyArray<string> = [
  'impersonation_sessions',
  'impersonation_permissions',
  'debug_sessions',
  'captured_queries',
  'captured_api_calls',
  'cache_entries_snapshot',
  'feature_flag_overrides',
  'ImpersonationModule',
  'ImpersonationService',
  'ImpersonationController',
  'DebugToolsModule',
  'DebugToolsController',
  'X-Impersonate-User',
  'ENABLE_DEBUG_TOOLS',
  'system/impersonation',
  'system/debug',
];

const SEARCH_ROOTS: ReadonlyArray<string> = [
  'apps',
  'libs',
  'platform',
  'web',
  'tests',
  'e2e',
  'infrastructure',
  'scripts',
  'tools',
  '.claude/allowlists',
  'docker-compose.droplet.yml',
  'docker-compose.staging.yml',
];

/** Paths where a retired identifier is a historical record, not live code. */
const HISTORICAL_PATH = /(^|\/)(migrations|\.archive|dist)\//;

/** `git grep -l`; exit status 1 means "no match". */
function gitGrepFiles(patterns: ReadonlyArray<string>): string[] {
  try {
    return execFileSync(
      'git',
      [
        '-C',
        REPO_ROOT,
        'grep',
        '-l',
        '-F',
        ...patterns.flatMap((p) => ['-e', p]),
        '--',
        ...SEARCH_ROOTS,
      ],
      { encoding: 'utf8' },
    )
      .split('\n')
      .filter(Boolean);
  } catch (err: unknown) {
    const status = (err as { status?: number }).status;
    if (status === 1) return [];
    throw err;
  }
}

describe('INVARIANT: one cross-tenant access authority — the impersonation subsystem stays deleted (ADR-0007)', () => {
  it('no live source, test, config or deploy artefact names a retired impersonation or debug-tools identifier', () => {
    const offenders = gitGrepFiles(RETIRED_IDENTIFIERS)
      .filter((path) => !HISTORICAL_PATH.test(path))
      // This spec and the PROTECTED_TABLES docblock explain the deletion by name.
      .filter((path) => path !== 'tests/invariants/cross-tenant-authority-ssot.spec.ts')
      .filter((path) => path !== 'libs/backend-common/src/constants/protected-tables.ts')
      // Baseline ledger whose notes narrate past cleanups; history, not code.
      .filter((path) => path !== 'tools/gates/type-check-spec-baseline.json');
    expect(offenders).toEqual([]);
  });

  it('the retirement migration archives the sessions without their bearer material and discards the debug captures', () => {
    const migration = readFileSync(
      resolve(
        REPO_ROOT,
        'apps/admin-api-service/src/migrations/1808500000000-RetireImpersonationAndDebugTools.ts',
      ),
      'utf8',
    );
    expect(migration).toMatch(/to_jsonb\(t\) - 'impersonationToken' - 'originalSessionToken'/);
    for (const table of [
      'captured_queries',
      'captured_api_calls',
      'cache_entries_snapshot',
      'feature_flag_overrides',
      'debug_sessions',
    ]) {
      expect(migration).toMatch(new RegExp(`DROP TABLE IF EXISTS "admin"\\."${table}"`));
      expect(migration).not.toMatch(new RegExp(`SELECT '${table}'`));
    }
  });
});
