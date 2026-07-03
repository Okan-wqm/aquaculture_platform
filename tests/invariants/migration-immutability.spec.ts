/**
 * Platform-wide invariant — migration-immutability:
 *
 * **An already-shipped TypeORM migration file (timestamped, under
 * apps/<svc>/src/.../migrations/) is IMMUTABLE. Editing one in place — rather
 * than superseding it with a NEW forward migration — is a CI failure, unless
 * explicitly waived with a `MIGRATION-IMMUTABLE-OK:` line in the PR body.**
 *
 * # WHY
 *
 * TypeORM's `MigrationExecutor` records the ledger row by migration NAME, so an
 * already-applied migration is never re-run. Editing such a file changes the
 * source the service compiles from while the DB that already recorded the
 * migration stays frozen in the PRE-edit shape — "ledger says applied, DB says
 * lagged".
 *
 * This is exactly the 2026-06 tenant-provisioning incident: migration
 * `1800400000000-TenantProvisioningWorkflow` was hand-edited (commit
 * `42695736f`) after it had already shipped (commit `e147c9dfb`) to add the
 * lease columns and an `auth.tenants` GRANT/REVOKE. Neither landed on the
 * deployed database, so every `POST /api/v1/tenants` died with
 * `QueryFailedError: column "leaseToken" does not exist` → a redacted 500
 * "Database operation failed". Migrations are append-only by construction;
 * corrections MUST be new forward migrations.
 *
 * # MECHANICS
 *
 * The work is done by `tools/gates/migration-immutability-witness.ts`, which
 * runs in exactly ONE place: the dedicated `migration-immutability-witness` job
 * in `db-migration-check.yml`, owning the full env contract (PR_BODY for the
 * waiver + BASE_SHA for the diff base). This spec asserts, structurally, that
 * the gate is wired and that every workflow step invoking it exports the full
 * env contract (so no executor can fork the verdict — cf. INFRA-HIGH-010).
 */

import { execSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

describe('INVARIANT — migration-immutability (shipped migrations are append-only)', () => {
  it('gate script exists and is executable', () => {
    const exists = execSync(
      `test -f ${REPO_ROOT}/tools/gates/migration-immutability-witness.ts && echo ok`,
      { encoding: 'utf8' },
    ).trim();
    expect(exists).toBe('ok');
  });

  it('package.json declares the gates:migration-immutability-witness script', () => {
    const pkg = JSON.parse(
      readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts['gates:migration-immutability-witness']).toBeDefined();
    expect(pkg.scripts['gates:migration-immutability-witness']).toMatch(
      /migration-immutability-witness\.ts/,
    );
  });

  it('GHA workflow db-migration-check.yml declares the migration-immutability-witness job', () => {
    const yml = readFileSync(
      join(REPO_ROOT, '.github', 'workflows', 'db-migration-check.yml'),
      'utf8',
    );
    expect(yml).toMatch(/migration-immutability-witness:/);
    expect(yml).toMatch(/gates:migration-immutability-witness/);
  });

  // Single-executor env contract: the gate's verdict depends on PR_BODY (waiver
  // channel) and BASE_SHA (diff base). Any workflow step invoking it without
  // BOTH forks the verdict from the dedicated job's.
  it('every workflow step invoking the gate exports PR_BODY and BASE_SHA', () => {
    const wfDir = join(REPO_ROOT, '.github', 'workflows');
    const invokers = readdirSync(wfDir)
      .filter((f) => /\.ya?ml$/.test(f))
      .filter((f) =>
        readFileSync(join(wfDir, f), 'utf8').includes(
          'gates:migration-immutability-witness',
        ),
      );

    expect(invokers).toContain('db-migration-check.yml');

    for (const f of invokers) {
      const yml = readFileSync(join(wfDir, f), 'utf8');
      expect(yml).toMatch(
        /PR_BODY:\s*\$\{\{\s*github\.event\.pull_request\.body\s*\}\}/,
      );
      expect(yml).toMatch(
        /BASE_SHA:\s*\$\{\{\s*github\.event\.pull_request\.base\.sha\s*\}\}/,
      );
    }
  });
});
