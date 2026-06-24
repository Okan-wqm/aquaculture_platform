#!/usr/bin/env ts-node
/**
 * migration-deletion-witness — Wave 4-A.2 Part D.
 * ============================================================================
 *
 * # Purpose
 *
 * Catches the silent-regression class where a migration file is deleted
 * from `apps/<svc>/src/.../migrations/` (or a sibling `.sql`) without the
 * deletion either:
 *
 *   (a) being mirrored by an identical migration with the same timestamp
 *       in another service (a service split / rename);
 *   (b) carrying a CREATE-equivalent into the platform-wide
 *       `infrastructure/docker/init-scripts/` set (the script-owned
 *       fallback for tables that need to "just exist" before any service
 *       queries them); or
 *   (c) being explicitly waived by a `// DELETE-OK: <reason>` line in
 *       the PR description (env: PR_BODY).
 *
 * # Why this gate exists
 *
 * Wave 4-A.1 + Wave 4-A.2 deleted three init scripts (03-farm-tables-and-
 * seed.sql, 04-billing-tables.sql, 11-service-audit-tables.sql) only
 * because the equivalent CREATE TABLE statements were already owned by
 * each service's Wave-1 baseline migration. Without a deletion-witness
 * gate, a future PR could delete the wrong migration and silently lose
 * the table definition — same regression class as the cleaner-fish
 * incident main-deletion-witness.ts (q.v.) catches for code blocks.
 *
 * # Algorithm
 *
 *   1. `git diff --name-status <base>..<head>` — list every D entry.
 *   2. Filter to migration files (path matches `/migrations/` AND
 *      extension is `.ts` or `.sql`) plus init-scripts that contain
 *      table definitions.
 *   3. For each deleted migration:
 *        - witness (a): another migration in the diff (any service) with
 *          the same numeric timestamp prefix and sibling table-creating
 *          SQL? Heuristic — match the leading `<digits>-` segment.
 *        - witness (b): an `infrastructure/docker/init-scripts/*.{sh,sql}`
 *          file in the diff that contains a `CREATE TABLE` for any of the
 *          tables the deleted migration created? Heuristic — pull every
 *          `CREATE TABLE [IF NOT EXISTS] <schema>.<name>` from the deleted
 *          file and require at least one to appear in an init-script in
 *          the diff (or in the current init-scripts/ tree).
 *        - witness (c): the PR body (env PR_BODY) contains a line
 *          `// DELETE-OK: ...` mentioning the deleted file name.
 *   4. If none of (a/b/c) hold, fail loudly with the unaccounted-for
 *      deletion list.
 *
 * # Exit codes
 *
 *   0 — every deleted migration carries a valid witness.
 *   1 — at least one deletion is unaccounted-for.
 *   2 — invocation error (cannot resolve diff base, etc.).
 *
 * # Invocation
 *
 *   ts-node tools/gates/migration-deletion-witness.ts --diff-base origin/main
 *   ts-node tools/gates/migration-deletion-witness.ts --diff-base HEAD~1
 *
 * Pre-commit / CI: chained after migration-sql-lint and
 * schema-drift-registration in the gate-runner script.
 */

/* eslint-disable no-console */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// CommonJS resolution — see schema-drift-registration.ts for rationale.
const REPO_ROOT = resolve(__dirname, '..', '..');

interface Args {
  readonly diffBase: string;
}

function parseArgs(): Args {
  const raw = process.argv.slice(2);
  let diffBase = 'origin/main';
  for (let i = 0; i < raw.length; i++) {
    const arg = raw[i];
    if (!arg) continue;
    const next = raw[i + 1];
    if (arg === '--diff-base' && next) {
      diffBase = next;
      i++;
    } else if (arg.startsWith('--diff-base=')) {
      const value = arg.slice('--diff-base='.length);
      if (value) diffBase = value;
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
  } catch (err) {
    const e = err as { stdout?: Buffer; stderr?: Buffer };
    const msg = `git ${cmd}\n${e.stdout?.toString() ?? ''}\n${
      e.stderr?.toString() ?? ''
    }`;
    throw new Error(msg);
  }
}

interface DiffEntry {
  readonly status: string;
  readonly path: string;
}

function diffEntries(base: string): DiffEntry[] {
  const out = git(`diff --name-status ${base}..HEAD`);
  const entries: DiffEntry[] = [];
  for (const line of out.split('\n')) {
    if (line.trim().length === 0) continue;
    // Status is the leading non-tab char(s), then a tab, then the path.
    // Renames have format `R100\tfrom\tto` — treat as A on `to`.
    const parts = line.split('\t');
    const status = parts[0];
    if (!status) continue;
    const path =
      status.startsWith('R') || status.startsWith('C') ? parts[2] : parts[1];
    if (!path) continue;
    entries.push({
      status: status.startsWith('R') || status.startsWith('C') ? 'A' : status,
      path,
    });
  }
  return entries;
}

function isMigrationFile(path: string): boolean {
  return /[\\/]migrations[\\/][^\\/]+\.(ts|sql)$/i.test(path);
}

function isInitScript(path: string): boolean {
  return /^infrastructure[\\/]docker[\\/]init-scripts[\\/].+\.(sh|sql)$/i.test(
    path,
  );
}

/**
 * Pull every `CREATE TABLE [IF NOT EXISTS] <ident>` from a SQL or TS
 * source. Returns the unqualified table name (last segment) plus the
 * schema-qualified form when present. Used to match a deletion against a
 * CREATE elsewhere in the diff or the current tree.
 */
function extractCreateTables(source: string): readonly string[] {
  const re =
    /\bCREATE\s+(?:TEMP(?:ORARY)?\s+|UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["\w.]+/gi;
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const raw = m[0];
    if (!raw) continue;
    const ident = raw
      .replace(/^\bCREATE\s+(?:TEMP(?:ORARY)?\s+|UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?/i, '')
      .trim();
    out.add(ident.toLowerCase());
    // Also store unqualified suffix for cross-script matching.
    const dot = ident.indexOf('.');
    if (dot >= 0) {
      out.add(ident.slice(dot + 1).toLowerCase());
    }
  }
  return [...out];
}

/**
 * Pull the leading numeric timestamp from a migration filename. Returns
 * null when the filename does not start with at least 10 digits (the
 * shape every Wave migration uses).
 */
function timestampPrefix(path: string): string | null {
  const base = path.split(/[\\/]/).pop() ?? path;
  const m = /^(\d{10,})-/.exec(base);
  return m?.[1] ?? null;
}

interface Witness {
  readonly kind: 'mirror' | 'init-script' | 'pr-body';
  readonly evidence: string;
}

function findMirrorWitness(
  deleted: DiffEntry,
  diffByStatus: Map<string, DiffEntry[]>,
): Witness | null {
  const ts = timestampPrefix(deleted.path);
  if (!ts) return null;
  const added = diffByStatus.get('A') ?? [];
  for (const a of added) {
    if (!isMigrationFile(a.path)) continue;
    if (timestampPrefix(a.path) === ts) {
      return { kind: 'mirror', evidence: a.path };
    }
  }
  return null;
}

function findInitScriptWitness(
  deleted: DiffEntry,
  baseRef: string,
): Witness | null {
  // Pull deleted file content from the base ref so we can read its
  // CREATE TABLE statements (working-tree copy is gone).
  let deletedSource: string;
  try {
    deletedSource = git(`show ${baseRef}:${deleted.path}`);
  } catch {
    return null;
  }
  const tables = extractCreateTables(deletedSource);
  if (tables.length === 0) {
    // Seed-only / data-only file with no CREATE TABLE statements has no
    // table-creation contract to witness. Mark as auto-witnessed: the
    // deletion is harmless from the schema-ownership perspective. Author
    // intent is captured by the PR review (or PR_BODY DELETE-OK marker
    // for stricter posture).
    return {
      kind: 'init-script',
      evidence:
        '(no CREATE TABLE statements in deleted file — seed-only / data-only ' +
        'deletion has no schema-ownership contract to witness)',
    };
  }

  // Scan all init-scripts in the CURRENT working tree (post-deletion
  // state) for CREATE TABLE statements covering the same tables.
  const initDir = resolve(REPO_ROOT, 'infrastructure/docker/init-scripts');
  if (!existsSync(initDir)) return null;
  const dirEntries = (() => {
    try {
      return execSync(`ls ${initDir}`, { encoding: 'utf8' })
        .split('\n')
        .filter((f) => f.length > 0);
    } catch {
      return [];
    }
  })();
  for (const f of dirEntries) {
    const abs = resolve(initDir, f);
    if (!existsSync(abs)) continue;
    const content = readFileSync(abs, 'utf8');
    const found = extractCreateTables(content);
    const intersection = tables.filter((t) => found.includes(t));
    if (intersection.length > 0) {
      return {
        kind: 'init-script',
        evidence: `infrastructure/docker/init-scripts/${f} covers ${intersection.join(
          ', ',
        )}`,
      };
    }
  }

  // Also scan migrations across the whole repo (baseline ownership case
  // — Wave 4-A.1 moved init-script tables into TypeORM migrations, and a
  // Wave 4-A.2 deletion is witnessed by that pre-existing baseline).
  const allMigrations = (() => {
    try {
      return execSync(
        `find ${REPO_ROOT}/apps -path '*migrations*' \\( -name '*.ts' -o -name '*.sql' \\)`,
        { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
      )
        .split('\n')
        .filter((f) => f.length > 0);
    } catch {
      return [];
    }
  })();
  for (const f of allMigrations) {
    if (!existsSync(f)) continue;
    const content = readFileSync(f, 'utf8');
    const found = extractCreateTables(content);
    const intersection = tables.filter((t) => found.includes(t));
    if (intersection.length > 0) {
      return {
        kind: 'init-script',
        evidence: `${f.replace(REPO_ROOT + '/', '')} carries CREATE TABLE for ${intersection.join(
          ', ',
        )}`,
      };
    }
  }
  return null;
}

function findPrBodyWitness(deleted: DiffEntry): Witness | null {
  const body = process.env.PR_BODY ?? '';
  if (!body) return null;
  const baseName = deleted.path.split(/[\\/]/).pop() ?? deleted.path;
  // Look for `// DELETE-OK: ... <baseName>` on a single line OR a
  // `DELETE-OK: <path>` inline reference to the full path.
  const lineRe = new RegExp(
    `(?:\\/\\/\\s*)?DELETE-OK:[^\\n]*\\b${escapeRegex(baseName)}\\b`,
    'i',
  );
  const pathRe = new RegExp(
    `(?:\\/\\/\\s*)?DELETE-OK:[^\\n]*\\b${escapeRegex(deleted.path)}\\b`,
    'i',
  );
  if (lineRe.test(body) || pathRe.test(body)) {
    return {
      kind: 'pr-body',
      evidence: `PR_BODY DELETE-OK marker for ${baseName}`,
    };
  }
  return null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface Result {
  readonly deleted: DiffEntry;
  readonly witness: Witness | null;
}

function main(): void {
  const args = parseArgs();
  let entries: DiffEntry[];
  try {
    entries = diffEntries(args.diffBase);
  } catch (err) {
    console.error(
      `migration-deletion-witness: failed to compute diff base ${args.diffBase}: ${
        (err as Error).message
      }`,
    );
    process.exit(2);
  }

  const deleted = entries
    .filter((e) => e.status === 'D')
    .filter((e) => isMigrationFile(e.path) || isInitScript(e.path));

  if (deleted.length === 0) {
    console.log(
      'migration-deletion-witness: PASS — no migration / init-script ' +
        'deletions in this diff.',
    );
    return;
  }

  const byStatus = new Map<string, DiffEntry[]>();
  for (const e of entries) {
    const lst = byStatus.get(e.status) ?? [];
    lst.push(e);
    byStatus.set(e.status, lst);
  }

  const results: Result[] = deleted.map((d) => {
    const witness =
      findMirrorWitness(d, byStatus) ??
      findInitScriptWitness(d, args.diffBase) ??
      findPrBodyWitness(d);
    return { deleted: d, witness };
  });

  const unaccounted = results.filter((r) => r.witness === null);

  if (unaccounted.length === 0) {
    console.log(
      `migration-deletion-witness: PASS — all ${deleted.length} deletion(s) ` +
        `carry a valid witness.`,
    );
    for (const r of results) {
      console.log(`  ${r.deleted.path}`);
      console.log(`    witness: [${r.witness!.kind}] ${r.witness!.evidence}`);
    }
    return;
  }

  console.error('migration-deletion-witness: FAIL');
  console.error('');
  console.error(
    `${unaccounted.length} deletion(s) without a valid witness:`,
  );
  console.error('');
  for (const r of unaccounted) {
    console.error(`  ${r.deleted.path}`);
  }
  console.error('');
  console.error('Cure paths (any one is sufficient):');
  console.error(
    "  (a) add a sibling migration with the same numeric timestamp prefix",
  );
  console.error('      that re-creates the table in the new owning service;');
  console.error(
    '  (b) carry a CREATE-equivalent into infrastructure/docker/init-scripts/',
  );
  console.error(
    '      OR an existing baseline migration with a matching CREATE TABLE;',
  );
  console.error(
    '  (c) document the deletion in the PR body with a `DELETE-OK: <filename>`',
  );
  console.error(
    '      line (env PR_BODY) explaining why the table is no longer needed.',
  );
  process.exit(1);
}

main();
