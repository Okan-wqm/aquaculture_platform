#!/usr/bin/env ts-node
/**
 * migration-immutability-witness — shipped-migration in-place-edit guard.
 * ============================================================================
 *
 * # Purpose
 *
 * Catches the silent-drift class where an ALREADY-SHIPPED TypeORM migration
 * file under `apps/<svc>/src/.../migrations/<timestamp>-*.ts` (or a sibling
 * `.sql`) is EDITED IN PLACE rather than superseded by a new forward migration.
 *
 * # The incident this prevents
 *
 * `1800400000000-TenantProvisioningWorkflow` was created by commit `e147c9dfb`
 * and then HAND-EDITED by commit `42695736f` (lease columns + an auth.tenants
 * GRANT/REVOKE were added to the same file). TypeORM's `MigrationExecutor`
 * records the ledger row by migration NAME, so an already-applied migration is
 * never re-run — the edited statements silently never landed on any database
 * that had already recorded the migration. The deployed
 * `admin.tenant_provisioning_runs` table stayed frozen in its pre-edit shape;
 * the runtime code (built from the edited source) referenced the missing
 * `leaseToken`/`leaseExpiresAt` columns, and EVERY `POST /api/v1/tenants` died
 * with `QueryFailedError: column "leaseToken" does not exist` → a redacted 500
 * "Database operation failed".
 *
 * This is the same "ledger says applied, DB says lagged" inviolable-rule
 * violation that the SAVEPOINT and entity-diff gates close from other angles.
 * Migrations are append-only by construction: once a migration has shipped, its
 * content is immutable and a correction MUST be a NEW forward migration.
 *
 * # Algorithm
 *
 *   1. `git diff --name-status <base>..HEAD` — list every entry.
 *   2. Keep status `M` (content modification) of timestamped migration files
 *      (path matches `/migrations/<10+ digits>-….(ts|sql)`), excluding files
 *      under an `.archive/` segment (archiving a migration is a legitimate
 *      lifecycle move handled by migration-deletion-witness).
 *   3. For each modified shipped migration, require a PR-body waiver line
 *      `MIGRATION-IMMUTABLE-OK: <filename> — <reason>` (env PR_BODY). The waiver
 *      exists only for genuinely content-neutral edits (a typo in a comment,
 *      a lint/format-only change) and carries CODEOWNERS review.
 *   4. If a modification has no waiver, fail loudly — the cure is to revert the
 *      edit and add a NEW forward migration that completes the desired state.
 *
 * # Exit codes
 *
 *   0 — no shipped migration was modified in place (or every modification is
 *       explicitly waived).
 *   1 — at least one shipped migration was edited in place without a waiver.
 *   2 — invocation error (cannot resolve diff base, etc.).
 *
 * # Invocation
 *
 *   ts-node tools/gates/migration-immutability-witness.ts --diff-base origin/main
 *   ts-node tools/gates/migration-immutability-witness.ts --diff-base HEAD~1
 *
 * CI: a parallel job in `.github/workflows/db-migration-check.yml`, alongside
 * migration-deletion-witness and entity-diff-witness.
 *
 * Note: output uses process.stdout/stderr.write rather than the console object,
 * so the gate needs no lint-silencing directive (which the tools/gates lint
 * policy bans) while still satisfying the no-console rule.
 */

import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

const out = (message: string): void => {
  process.stdout.write(`${message}\n`);
};
const err = (message: string): void => {
  process.stderr.write(`${message}\n`);
};

interface Args {
  readonly diffBase: string;
}

function parseArgs(): Args {
  const raw = process.argv.slice(2);
  let diffBase = 'origin/main';
  for (let i = 0; i < raw.length; i++) {
    const arg = raw[i];
    if (arg === undefined) continue;
    if (arg === '--diff-base') {
      const next = raw[i + 1];
      if (next !== undefined) {
        diffBase = next;
        i++;
      }
    } else if (arg.startsWith('--diff-base=')) {
      const value = arg.slice('--diff-base='.length);
      if (value.length > 0) {
        diffBase = value;
      }
    }
  }
  return { diffBase };
}

function git(cmd: string): string {
  try {
    return execSync(`git ${cmd}`, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const e = error as { stdout?: Buffer; stderr?: Buffer };
    throw new Error(
      `git ${cmd}\n${e.stdout?.toString() ?? ''}\n${e.stderr?.toString() ?? ''}`,
    );
  }
}

interface DiffEntry {
  readonly status: string;
  readonly path: string;
}

function diffEntries(base: string): DiffEntry[] {
  const stdout = git(`diff --name-status ${base}..HEAD`);
  return stdout
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .flatMap<DiffEntry>((line) => {
      const parts = line.split('\t');
      const status = parts[0];
      if (status === undefined) return [];
      // Renames/copies are `R100\told\tnew` — treat as a modification of the
      // NEW path so a rename-with-edit of a shipped migration is still caught.
      if (status.startsWith('R') || status.startsWith('C')) {
        const renamedTo = parts[2];
        return renamedTo === undefined ? [] : [{ status: 'M', path: renamedTo }];
      }
      const path = parts[1];
      return path === undefined ? [] : [{ status, path }];
    });
}

/**
 * A timestamped, non-archived migration file — the append-only set this gate
 * protects. `.archive/` moves are a legitimate lifecycle handled elsewhere.
 */
function isShippedMigrationFile(path: string): boolean {
  if (/[\\/]\.archive[\\/]/i.test(path)) return false;
  return /[\\/]migrations[\\/]\d{10,}-[^\\/]+\.(ts|sql)$/i.test(path);
}

function findWaiver(path: string): string | null {
  const body = process.env.PR_BODY ?? '';
  if (!body) return null;
  const baseName = path.split(/[\\/]/).pop() ?? path;
  const re = new RegExp(
    `MIGRATION-IMMUTABLE-OK:[^\\n]*\\b${escapeRegex(baseName)}\\b`,
    'i',
  );
  return re.test(body)
    ? `PR_BODY MIGRATION-IMMUTABLE-OK marker for ${baseName}`
    : null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function main(): void {
  const args = parseArgs();
  let entries: DiffEntry[];
  try {
    entries = diffEntries(args.diffBase);
  } catch (error) {
    err(
      `migration-immutability-witness: failed to compute diff base ${args.diffBase}: ${
        (error as Error).message
      }`,
    );
    process.exit(2);
  }

  const modified = entries
    .filter((e) => e.status === 'M')
    .filter((e) => isShippedMigrationFile(e.path));

  if (modified.length === 0) {
    out('migration-immutability-witness: PASS — no shipped migration was edited in place.');
    return;
  }

  const unaccounted = modified.filter((e) => findWaiver(e.path) === null);

  if (unaccounted.length === 0) {
    out(
      `migration-immutability-witness: PASS — all ${modified.length} migration ` +
        `edit(s) are explicitly waived.`,
    );
    for (const e of modified) {
      out(`  ${e.path}`);
      out(`    waiver: ${findWaiver(e.path)}`);
    }
    return;
  }

  err('migration-immutability-witness: FAIL');
  err('');
  err(`${unaccounted.length} already-shipped migration(s) were edited in place:`);
  err('');
  for (const e of unaccounted) {
    err(`  ${e.path}`);
  }
  err('');
  err('Shipped migrations are immutable — editing one that has already been recorded');
  err('in a deployed database\'s ledger silently never re-runs (the 2026-06 tenant-');
  err('provisioning drift incident). Cure paths (any one is sufficient):');
  err('  (a) REVERT the edit and add a NEW forward migration (next free timestamp)');
  err('      that idempotently completes the desired state. Name it after the FEATURE');
  err('      it adds — Reconcile*/Repair*/Heal*/Align*EntitySurface/Replay*Alignment/');
  err('      Sync*ToDb names are rejected by tests/invariants/drift-repair-naming.spec.ts; OR');
  err('  (b) for a genuinely content-neutral edit (comment/lint-only), add a PR-body');
  err('      line `MIGRATION-IMMUTABLE-OK: <filename> — <reason>` (CODEOWNERS-reviewed).');
  process.exit(1);
}

main();
