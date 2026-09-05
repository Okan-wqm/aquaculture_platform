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

function read(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf8');
}

/** Drop block + line comments so docstring mentions do not register as code. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(?<!:)\/\/.*$/, ''))
    .join('\n');
}

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
        // A file being introduced in this very change is untracked until staged;
        // the gate must see it, or a new definer would slip through on its first PR.
        '--untracked',
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

  describe('the kernel act-as middleware is the only cross-tenant authority', () => {
    it('exactly one EffectiveTenantMiddleware class exists, in libs/backend-common', () => {
      const definers = gitGrepFiles([
        'class EffectiveTenantMiddleware',
        'class CaptureRequestedTenantMiddleware',
      ])
        .filter((path) => !HISTORICAL_PATH.test(path))
        .filter((path) => path !== 'tests/invariants/cross-tenant-authority-ssot.spec.ts');
      expect(definers).toEqual([
        'libs/backend-common/src/middleware/effective-tenant.middleware.ts',
      ]);
    });

    it('the act-as headers are kernel CORS defaults, so no ingress can forget them', () => {
      const factory = read('libs/backend-common/src/bootstrap/create-service-app.ts');
      for (const header of ['X-Act-As-Tenant', 'X-Act-As-Reason', 'X-Act-As-Ticket']) {
        expect(factory).toContain(`'${header}'`);
      }
    });

    it('a cross-tenant act-as cannot resolve without a reason', () => {
      const middleware = read('libs/backend-common/src/middleware/effective-tenant.middleware.ts');
      expect(middleware).toMatch(/reason: this\.requireReason\(r\.requestedActAsReason\)/);
      expect(middleware).toMatch(/throw new ForbiddenException\([\s\S]*?requires a justification/);
    });

    it('the signed assertion carries the act-as claims and the subgraph rebuilds them', () => {
      expect(read('libs/backend-common/src/http/gateway-verified-user-assertion.ts')).toMatch(
        /actAs:\s*\{\s*homeTenantId: input\.actAs\.homeTenantId/,
      );
      expect(
        read('libs/backend-common/src/middleware/verified-user-assertion.middleware.ts'),
      ).toMatch(/req\.actAs = \{[\s\S]*?homeTenantId: assertion\.actAs\.homeTenantId/);
      for (const signer of [
        'apps/gateway-api/src/federation/authenticated-data-source.ts',
        'apps/gateway-api/src/proxy/service-proxy.service.ts',
      ]) {
        expect(stripComments(read(signer))).toMatch(/actAs[:,]/);
      }
    });

    it('audit rows attribute an act-as write to the actor home tenant and persist the justification', () => {
      const interceptor = stripComments(
        read('libs/backend-common/src/audit/audited-operation.interceptor.ts'),
      );
      expect(interceptor).toMatch(/actorHomeTenantId: ctx\.actorHomeTenantId/);
      expect(interceptor).toMatch(
        /actorHomeTenantId: request\.actAs \? request\.actAs\.homeTenantId/,
      );
      expect(interceptor).toMatch(
        /metadata\['actAs'\] = \{ reason: ctx\.actAs\.reason, ticket: ctx\.actAs\.ticket \}/,
      );
    });
  });
});
