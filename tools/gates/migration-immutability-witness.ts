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
 *      `MIGRATION-IMMUTABLE-OK: <repo-relative path> — <reason>` (env PR_BODY).
 *      The waiver exists only for genuinely content-neutral edits (a typo in a
 *      comment, a lint/format-only change) and carries CODEOWNERS review. A bare
 *      basename is accepted only while it names exactly one shipped migration in
 *      the repository: fourteen services call their first migration
 *      `1800000000000-Baseline.ts`, so a bare name there waived all fourteen at
 *      once, including services the PR never touched (PROC-MEDIUM-021).
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

/**
 * Every shipped migration tracked in the repository, by basename.
 *
 * The waiver used to match the BASENAME alone, and fourteen services name their
 * first migration `1800000000000-Baseline.ts`. One waiver line therefore waived
 * every Baseline in the repository at once, including services the PR never
 * touched — a gate whose exemption is wider than anything a reviewer would grant
 * on purpose (PROC-MEDIUM-021). The counts below decide when a basename is
 * still safe shorthand and when it is not.
 */
function shippedMigrationsByBaseName(): Map<string, string[]> {
  const index = new Map<string, string[]>();
  let tracked: string;
  try {
    tracked = git('ls-files -- "*/migrations/*"');
  } catch {
    // No index to consult (shallow checkout, detached tooling run): fall back to
    // treating every basename as ambiguous, which only ever asks for MORE
    // precision in the waiver.
    return index;
  }
  for (const path of tracked.split('\n')) {
    if (path.trim().length === 0) continue;
    if (!isShippedMigrationFile(path)) continue;
    const baseName = path.split(/[\\/]/).pop() ?? path;
    index.set(baseName, [...(index.get(baseName) ?? []), path]);
  }
  return index;
}

const SHIPPED_BY_BASENAME = shippedMigrationsByBaseName();

/**
 * A waiver must name the repo-relative PATH of the file it waives.
 *
 * A bare basename is accepted only while it is unambiguous across the whole
 * repository — there, the two spellings identify exactly the same file and
 * demanding the longer one would be ceremony. The moment a second service
 * ships a migration with that name, the shorthand stops being accepted and the
 * waiver has to say which file it means.
 *
 * Exported and free of git/env so the decision itself can be tested rather than
 * only asserted to exist — `tests/invariants/migration-immutability.spec.ts`.
 */
export function resolveWaiver(
  path: string,
  body: string,
  shippedByBaseName: ReadonlyMap<string, readonly string[]>,
): string | null {
  if (!body) return null;

  const marker = (needle: string): boolean =>
    new RegExp(`MIGRATION-IMMUTABLE-OK:[^\\n]*\\b${escapeRegex(needle)}(?!\\S)`, 'i').test(body);

  if (marker(path)) {
    return `PR_BODY MIGRATION-IMMUTABLE-OK marker for ${path}`;
  }

  const baseName = path.split(/[\\/]/).pop() ?? path;
  const sharing = shippedByBaseName.get(baseName) ?? [];
  if (sharing.length === 1 && marker(baseName)) {
    return `PR_BODY MIGRATION-IMMUTABLE-OK marker for ${baseName} (unambiguous repo-wide)`;
  }
  return null;
}

function findWaiver(path: string): string | null {
  return resolveWaiver(path, process.env.PR_BODY ?? '', SHIPPED_BY_BASENAME);
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
  err('      line `MIGRATION-IMMUTABLE-OK: <repo-relative path> — <reason>`');
  err('      (CODEOWNERS-reviewed), one per file:');
  for (const e of unaccounted) {
    err(`        MIGRATION-IMMUTABLE-OK: ${e.path} — <reason>`);
  }
  err('      A bare filename is accepted only when it is unique repo-wide. All');
  err('      fourteen Baselines are named 1800000000000-Baseline.ts, so a bare');
  err('      name there would waive every one of them (PROC-MEDIUM-021).');
  process.exit(1);
}

if (require.main === module) main();
