/**
 * Invariant: application code does not iterate tenant schemas by NAME.
 *
 * `listTenantSchemas(dataSource)` returns schema names. A worker that loops over
 * them and opens a QueryRunner with `SET search_path TO "<schema>"` has routed
 * the tables but bound NO tenant: every tenant table sits under FORCE
 * row-level security (policy: `tenantId = app.current_tenant`), so under the
 * non-owner service role that session reads ZERO rows and has every write
 * refused. The worker does not fail, it finds "nothing to do": on production
 * `farm_service` saw 0 of the test tenant's 8 tasks, so `task.detect-overdue`
 * never flagged a task, `task.generate-due` never generated one and no AutoRule
 * ever fired (FARM-HIGH-481, after the feeding engine's discovery, FARM-CRITICAL-479).
 *
 * A schema name also cannot be bound: `tenant_<16 hex>` is a truncated hash of
 * the tenant id. The sanctioned shapes take the canonical identity from the
 * platform ledger and bind it:
 *
 *   - `forEachVerifiedTenantSchema` / `forEachVerifiedRetainedTenantSchema`:
 *     bounded fan-out, one transaction per tenant, `app.current_tenant` bound and
 *     read back, the tenant's AsyncLocalStorage frame around the handler;
 *   - `findTenantsMatching`: "which tenants have X?", asked per tenant under its
 *     own RLS context;
 *   - `runInTenantTransaction` / `runInTenantRead` for one known tenant.
 *
 * Scope: `apps/<app>/**` outside tests and migrations. Two exemptions are
 * infrastructure that administers schemas as the owner. Everything else listed
 * below is a KNOWN GAP held under PLAT-HIGH-938: the spec fails when a gap
 * grows (new code must not add one) AND when it shrinks without the recorded
 * count being lowered, so the ratchet only tightens.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** Infrastructure that iterates schemas to ADMINISTER them (DDL, migration), as the owner. */
const EXEMPT_PREFIXES: Readonly<Record<string, string>> = {
  'apps/db-migrate/': 'the migration runner: DDL over every tenant schema as the schema owner',
  'apps/admin-api-service/src/database-management/':
    'platform schema administration (inspection and DDL), not tenant-data work',
};

/** file -> number of `listTenantSchemas(` call sites still present. Lower it, never raise it. */
const KNOWN_GAPS: Readonly<Record<string, number>> = {
  // 8 jobs, inert under RLS today. NOTE `minio.orphan-cleanup` DELETES objects:
  // converting it activates a destructive job, so it needs its own review.
  'apps/farm-service/src/scheduler/cron-jobs.service.ts': 8,
  'apps/hr-service/src/leave/leave-accrual.service.ts': 2,
  'apps/hr-service/src/training/certification-expiry.service.ts': 1,
  'apps/messaging-service/src/compliance/services/retention-policy.service.ts': 2,
  'apps/messaging-service/src/partition/partition-manager.service.ts': 1,
  'apps/messaging-service/src/ai/services/knowledge-extraction.service.ts': 1,
  'apps/sensor-service/src/timescale/continuous-aggregate.service.ts': 1,
};

const CALL = /\blistTenantSchemas\s*\(/g;

function applicationSources(): string[] {
  return execFileSync('git', ['ls-files', 'apps'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(
      (file) =>
        /^apps\/[^/]+\/.+\.ts$/.test(file) &&
        !/(\.spec\.ts|\.test\.ts|\.d\.ts)$/.test(file) &&
        !/(^|\/)(__tests__|migrations|\.archive|test|e2e)\//.test(file),
    );
}

function callsIn(file: string): number {
  return (readFileSync(path.join(REPO_ROOT, file), 'utf8').match(CALL) ?? []).length;
}

describe('application code iterates tenant schemas through the tenant-binding helpers', () => {
  const callers = applicationSources()
    .map((file) => ({ file, calls: callsIn(file) }))
    .filter((entry) => entry.calls > 0);
  const exempt = (file: string): boolean =>
    Object.keys(EXEMPT_PREFIXES).some((prefix) => file.startsWith(prefix));

  it('finds the callers it is meant to police', () => {
    // A guard that matches nothing passes forever: pin that the scan sees them.
    expect(callers.map((entry) => entry.file)).toEqual(
      expect.arrayContaining([
        'apps/farm-service/src/scheduler/cron-jobs.service.ts',
        'apps/hr-service/src/leave/leave-accrual.service.ts',
      ]),
    );
  });

  it('no file outside the exemptions and the known gaps lists tenant schemas by name', () => {
    const unlisted = callers
      .filter((entry) => !exempt(entry.file) && !(entry.file in KNOWN_GAPS))
      .map((entry) => `${entry.file} (${entry.calls})`);

    expect(unlisted).toEqual([]);
  });

  it('a known gap never grows', () => {
    const grown = callers
      .filter((entry) => entry.file in KNOWN_GAPS && entry.calls > (KNOWN_GAPS[entry.file] ?? 0))
      .map((entry) => `${entry.file}: ${entry.calls} > ${KNOWN_GAPS[entry.file]}`);

    expect(grown).toEqual([]);
  });

  it('a known gap that shrank or went away leaves the list (lower the count, then delete the entry)', () => {
    const actual = new Map(callers.map((entry) => [entry.file, entry.calls]));
    const stale = Object.entries(KNOWN_GAPS)
      .filter(([file, recorded]) => (actual.get(file) ?? 0) !== recorded)
      .map(([file, recorded]) => `${file}: recorded ${recorded}, found ${actual.get(file) ?? 0}`);

    expect(stale).toEqual([]);
  });

  it('every exemption names a path that still exists in the repository', () => {
    const files = execFileSync('git', ['ls-files', 'apps'], { cwd: REPO_ROOT, encoding: 'utf8' });
    for (const prefix of Object.keys(EXEMPT_PREFIXES)) {
      expect(files).toContain(prefix);
    }
  });
});
