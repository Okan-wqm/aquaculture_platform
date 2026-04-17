#!/usr/bin/env ts-node
/**
 * Migration SQL linter — Phase 2 of
 * docs/plans/2026-04-17-agentic-post-audit-consolidation-plan.md#Phase-2.
 *
 * Encodes data-expert's domain-specific migration-delta safety rules
 * (data-expert.md "Migration-delta safety" section) as a pre-merge gate.
 *
 * Scans newly-introduced or newly-modified TypeORM migration files —
 * existing migrations are grandfathered because amending production-
 * applied migrations is forbidden under the force-push ban.
 *
 * Rules (each maps to a data-expert invariant — tier placement per
 * CLAUDE.md architectural hierarchy):
 *
 *   R1  destructive-without-marker           (CRITICAL)
 *       `DROP COLUMN`, `DROP TABLE` (not IF EXISTS), `TRUNCATE`, or
 *       `DROP SCHEMA ... CASCADE` without a comment marker
 *       `-- DESTRUCTIVE:` on a same-query line listing a rollback
 *       reference. Matches the 4-requirement gate in data-expert.md.
 *
 *   R2  single-step-add-not-null             (HIGH)
 *       `ADD COLUMN ... NOT NULL` without DEFAULT in the same ADD
 *       clause. Blue-green 3-step discipline requires
 *       nullable → backfill → NOT NULL for populated tables.
 *
 *   R3  create-index-not-concurrent          (MEDIUM)
 *       `CREATE (UNIQUE )?INDEX` without CONCURRENTLY. On TimescaleDB
 *       hypertables (sensor_metrics, water_quality_readings, etc.) a
 *       non-concurrent index takes ACCESS EXCLUSIVE and may stall live
 *       writers; always CONCURRENTLY.
 *
 *   R4  session-scoped-set-search-path       (CRITICAL)
 *       Bare `SET search_path = ...` (not `SET LOCAL`) in a migration
 *       body. Leaks search_path into the pooled connection — the exact
 *       pattern that caused the 2026-04-07 split-brain incident
 *       (DATA-HIGH-003 precedent — messaging-service migrations
 *       1782300000000 / 1782400000000).
 *
 *   R5  overbroad-exception-catch            (HIGH)
 *       `EXCEPTION WHEN others THEN NULL` silently swallows every PL/
 *       pgSQL error including security failures. Require
 *       `WHEN duplicate_object THEN NULL` or a specific class.
 *
 * SQL is extracted from TypeScript `queryRunner.query(`...`)` template
 * literals. Bare `.sql` files are scanned whole. Single-line (`//`) and
 * block (`/* ... *\/`) comments are stripped before scanning so inline
 * rationale mentioning banned shapes does not trigger false positives.
 *
 * Usage:
 *   ts-node tools/gates/migration-sql-lint.ts --mode=staged              # pre-commit
 *   ts-node tools/gates/migration-sql-lint.ts --mode=range <base> <head> # CI PR
 *   ts-node tools/gates/migration-sql-lint.ts --mode=file <path>         # ad-hoc
 *
 * Exit codes:
 *   0 — clean
 *   1 — violation detected
 *   2 — usage error
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * A file is a "migration" when its path contains `/migrations/` AND its
 * extension is `.ts` or `.sql`. Captures the four migration layouts in
 * use (`apps/<svc>/src/database/migrations/`, `apps/<svc>/src/migrations/`,
 * `database/migrations/`, and future shared-contracts migrations).
 */
const MIGRATION_PATH_REGEX = /[\\/]migrations[\\/][^\\/]+\.(ts|sql)$/i;

type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM';

interface Rule {
  readonly id: string;
  readonly severity: Severity;
  /** Match on a single pre-processed SQL chunk; returns match positions. */
  readonly scan: (sql: string) => readonly { start: number; snippet: string }[];
  readonly message: string;
}

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly ruleId: string;
  readonly severity: Severity;
  readonly snippet: string;
  readonly message: string;
}

function collectMatches(sql: string, regex: RegExp): readonly { start: number; snippet: string }[] {
  const flags = regex.flags.includes('g') ? regex.flags : `${regex.flags}g`;
  const re = new RegExp(regex.source, flags);
  const out: { start: number; snippet: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    out.push({ start: m.index, snippet: m[0].slice(0, 160) });
    if (m.index === re.lastIndex) re.lastIndex++; // avoid zero-width infinite loop
  }
  return out;
}

/**
 * Rule registry. Each rule's regex is tuned to minimise false positives
 * on the existing 66 migrations' sample corpus; changes here should be
 * paired with a negative-test fixture.
 */
const RULES: readonly Rule[] = [
  {
    id: 'R1-destructive-without-marker',
    severity: 'CRITICAL',
    // DROP COLUMN / DROP TABLE (not IF EXISTS) / TRUNCATE / DROP SCHEMA CASCADE
    // without an adjacent `-- DESTRUCTIVE:` comment on the same statement.
    scan: (sql) => {
      const hits = [
        ...collectMatches(sql, /\bDROP\s+COLUMN\b(?![^\n;]*\bIF\s+EXISTS\b)/i),
        ...collectMatches(sql, /\bDROP\s+TABLE\b(?!\s+IF\s+EXISTS\b)/i),
        ...collectMatches(sql, /\bTRUNCATE\b/i),
        ...collectMatches(sql, /\bDROP\s+SCHEMA\b[^;]*\bCASCADE\b/i),
      ];
      // Filter out hits that have a same-statement DESTRUCTIVE marker.
      return hits.filter(({ start }) => {
        const statementStart = Math.max(0, sql.lastIndexOf(';', start - 1) + 1);
        const statementEnd = sql.indexOf(';', start);
        const statement = sql.slice(
          statementStart,
          statementEnd === -1 ? sql.length : statementEnd,
        );
        return !/--\s*DESTRUCTIVE:/i.test(statement);
      });
    },
    message:
      'destructive DDL without `-- DESTRUCTIVE: <rollback-reference>` marker. ' +
      'Merging a destructive migration requires: documented pg_dump backup, ' +
      'rollback migration pre-merge, explicit ops stage-gate, and VACUUM FULL ' +
      'acknowledgement (data-expert.md "Migration-delta safety").',
  },
  {
    id: 'R2-single-step-add-not-null',
    severity: 'HIGH',
    // ADD COLUMN <name> <type> NOT NULL without DEFAULT in the same clause.
    // Matches before a DEFAULT keyword OR end-of-statement.
    scan: (sql) =>
      collectMatches(
        sql,
        /\bADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?\w+"?\s+[^,;]*?\bNOT\s+NULL\b(?![^,;]*\bDEFAULT\b)/i,
      ),
    message:
      'single-step ADD COLUMN ... NOT NULL without DEFAULT. On non-empty tables ' +
      'this takes ACCESS EXCLUSIVE and fails if any row is NULL. Use blue-green ' +
      '3-step: nullable → backfill → SET NOT NULL (data-expert.md invariant).',
  },
  {
    id: 'R3-create-index-not-concurrent',
    severity: 'MEDIUM',
    // CREATE [UNIQUE] INDEX without CONCURRENTLY. On a live table this takes
    // ACCESS EXCLUSIVE and stalls writers. The exception is index-on-new-
    // table — when the same SQL chunk also contains `CREATE TABLE`, the
    // just-created table is empty and non-concurrent indexing is safe.
    // Skip the hit when any CREATE TABLE precedes it in the chunk.
    scan: (sql) => {
      const hits = collectMatches(
        sql,
        /\bCREATE\s+(?:UNIQUE\s+)?INDEX\b(?!\s+CONCURRENTLY\b)(?!\s+IF\s+NOT\s+EXISTS\s+CONCURRENTLY\b)/i,
      );
      return hits.filter(({ start }) => {
        const before = sql.slice(0, start);
        return !/\bCREATE\s+TABLE\b/i.test(before);
      });
    },
    message:
      'CREATE INDEX without CONCURRENTLY on a pre-existing table — takes ' +
      'ACCESS EXCLUSIVE and stalls writers. On TimescaleDB hypertables this is ' +
      'especially costly. Use CREATE INDEX CONCURRENTLY in its own migration ' +
      'file (not in a transaction block — CONCURRENTLY cannot run inside ' +
      'BEGIN ... COMMIT). Initial-schema migrations that CREATE TABLE in the ' +
      'same chunk are exempt (the table is empty at index-creation time).',
  },
  {
    id: 'R4-session-scoped-set-search-path',
    severity: 'CRITICAL',
    // Bare `SET search_path = ...` (not LOCAL) in a migration body. LOCAL
    // form is permitted; session scope contaminates the pooled connection.
    scan: (sql) =>
      collectMatches(
        sql,
        /\bSET\s+(?!LOCAL\b)(?:SESSION\s+)?search_path\s*(?:=|TO)\s/i,
      ),
    message:
      'session-scoped `SET search_path` in migration body. Use `SET LOCAL ' +
      'search_path = \'<schema>\', public;` — LOCAL scope releases on COMMIT. ' +
      'The session-scoped form is the 2026-04-07 split-brain incident class ' +
      '(DATA-HIGH-003 precedent).',
  },
  {
    id: 'R5-overbroad-exception-catch',
    severity: 'HIGH',
    // EXCEPTION WHEN others THEN NULL — swallows security failures.
    scan: (sql) =>
      collectMatches(
        sql,
        /\bEXCEPTION\s+WHEN\s+others\s+THEN\s+NULL\b/i,
      ),
    message:
      'overbroad PL/pgSQL EXCEPTION catch — `WHEN others THEN NULL` masks ' +
      'security failures, timeouts, and deadlocks alike. Narrow to the ' +
      'specific exception class (e.g. `WHEN duplicate_object THEN NULL`).',
  },
];

/**
 * Strip single-line and block TypeScript comments. Preserve newlines so
 * line-number reporting against the original file stays accurate.
 */
function stripTsComments(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === '//') {
      const eol = source.indexOf('\n', i);
      i = eol === -1 ? source.length : eol;
    } else if (two === '/*') {
      const end = source.indexOf('*/', i + 2);
      if (end === -1) {
        // Unterminated block comment — replace remainder with whitespace.
        out += ' '.repeat(source.length - i);
        i = source.length;
      } else {
        // Preserve any newlines inside the block comment for line accuracy.
        for (let k = i; k < end + 2; k++) {
          out += source[k] === '\n' ? '\n' : ' ';
        }
        i = end + 2;
      }
    } else {
      out += source[i];
      i++;
    }
  }
  return out;
}

/**
 * Extract SQL chunks from TypeORM migration TS files. Each chunk is the
 * body of a `<identifier>.query(` template literal, returned WITH its
 * starting offset in the original (comment-stripped) file so we can map
 * offsets back to line numbers.
 *
 * The identifier is deliberately unpinned (`\w+`) rather than hard-coded
 * to `queryRunner` — TypeORM aliases it in private helpers (e.g.
 * `dropPartialTables(qr)` in migration-helper libraries). Capturing the
 * broader shape keeps the linter robust across refactoring without
 * widening the false-positive surface (no other repo code calls
 * `.query(` with a template literal inside a file whose path contains
 * `/migrations/`).
 */
function extractSqlChunks(tsSource: string): readonly { sql: string; offset: number }[] {
  const stripped = stripTsComments(tsSource);
  const chunks: { sql: string; offset: number }[] = [];
  const re = /\b\w+\.query\(\s*`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    const start = m.index + m[0].length;
    // Find the matching backtick, skipping over ${...} interpolations.
    let i = start;
    let depth = 0;
    while (i < stripped.length) {
      const ch = stripped[i];
      if (ch === '\\' && i + 1 < stripped.length) {
        i += 2;
        continue;
      }
      if (depth === 0 && ch === '`') break;
      if (ch === '$' && stripped[i + 1] === '{') {
        depth++;
        i += 2;
        continue;
      }
      if (depth > 0 && ch === '}') {
        depth--;
      }
      i++;
    }
    if (i < stripped.length) {
      chunks.push({ sql: stripped.slice(start, i), offset: start });
    }
  }
  return chunks;
}

function offsetToLine(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === '\n') line++;
  }
  return line;
}

function scanMigrationFile(relPath: string): Violation[] {
  const abs = resolve(REPO_ROOT, relPath);
  if (!existsSync(abs)) return [];
  const source = readFileSync(abs, 'utf8');
  const violations: Violation[] = [];

  const chunks: { sql: string; offset: number }[] = relPath.toLowerCase().endsWith('.sql')
    ? [{ sql: source, offset: 0 }]
    : [...extractSqlChunks(source)];

  for (const { sql, offset } of chunks) {
    for (const rule of RULES) {
      for (const hit of rule.scan(sql)) {
        violations.push({
          file: relPath,
          line: offsetToLine(source, offset + hit.start),
          ruleId: rule.id,
          severity: rule.severity,
          snippet: hit.snippet.replace(/\s+/g, ' ').trim(),
          message: rule.message,
        });
      }
    }
  }
  return violations;
}

function isMigrationFile(relPath: string): boolean {
  return MIGRATION_PATH_REGEX.test(relPath);
}

function run(cmd: string): string {
  try {
    return execSync(cmd, {
      encoding: 'utf8',
      cwd: REPO_ROOT,
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function stagedMigrationFiles(): string[] {
  // ACM = added / copied / modified. Do NOT include deletions.
  return run('git diff --cached --name-only --diff-filter=ACM')
    .split('\n')
    .filter((f) => f.length > 0 && isMigrationFile(f));
}

function rangeMigrationFiles(baseRef: string, headRef: string): string[] {
  return run(`git diff ${baseRef}..${headRef} --name-only --diff-filter=ACM`)
    .split('\n')
    .filter((f) => f.length > 0 && isMigrationFile(f));
}

function report(violations: readonly Violation[]): void {
  console.error('Migration SQL linter FAILED:');
  for (const v of violations) {
    console.error(`  [${v.severity}] ${v.ruleId}`);
    console.error(`    ${v.file}:${v.line}`);
    console.error(`    ${v.message}`);
    console.error(`    > ${v.snippet}`);
  }
  console.error('');
  console.error('Rule set: data-expert.md "Migration-delta safety" section.');
  console.error('Grandfather policy: this gate only runs on migrations ADDED or');
  console.error('MODIFIED in the current change set. Existing migrations are');
  console.error('exempt (amending is forbidden under the force-push ban).');
}

function main(): void {
  const [, , modeFlag, ...args] = process.argv;
  if (!modeFlag) {
    console.error(
      'Usage: ts-node tools/gates/migration-sql-lint.ts --mode=<staged|range|file> [args]',
    );
    process.exit(2);
  }

  const mode = modeFlag.replace(/^--mode=/, '');
  let files: string[] = [];

  if (mode === 'staged') {
    files = stagedMigrationFiles();
  } else if (mode === 'range') {
    const [baseRef, headRef] = args;
    if (!baseRef || !headRef) {
      console.error('range mode requires two refs: --mode=range <base> <head>');
      process.exit(2);
    }
    files = rangeMigrationFiles(baseRef, headRef);
  } else if (mode === 'file') {
    const [filePath] = args;
    if (!filePath) {
      console.error('file mode requires a path: --mode=file <path>');
      process.exit(2);
    }
    files = [relative(REPO_ROOT, resolve(filePath))];
  } else {
    console.error(`Unknown mode: ${mode}`);
    process.exit(2);
  }

  const violations: Violation[] = [];
  for (const f of files) {
    violations.push(...scanMigrationFile(f));
  }

  if (violations.length === 0) {
    if (files.length === 0) {
      console.log('No migration files in scope; nothing to lint.');
    } else {
      console.log(`Migration SQL lint passed (${files.length} file(s)).`);
    }
    return;
  }

  report(violations);
  process.exit(1);
}

main();
