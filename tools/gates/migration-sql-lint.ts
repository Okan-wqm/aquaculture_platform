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
 *   R6  create-table-without-if-not-exists   (MEDIUM) — Wave 4-A.2
 *       `CREATE TABLE <name>` without `IF NOT EXISTS`. Replays on
 *       partial-state DBs (e.g. a previous migration ran halfway and
 *       failed) crash on the second pass. Cure: always
 *       `CREATE TABLE IF NOT EXISTS`.
 *
 *   R7  create-index-not-idempotent          (MEDIUM) — Wave 4-A.2
 *       Folded into R3's matching: a `CREATE INDEX` is acceptable when
 *       it carries either `CONCURRENTLY` or `IF NOT EXISTS` (with the
 *       same-chunk CREATE TABLE exemption preserved).
 *
 *   R8  create-type-without-do-block         (MEDIUM) — Wave 4-A.2
 *       `CREATE TYPE ... AS ENUM` outside of a
 *       `DO $$ BEGIN ... EXCEPTION WHEN duplicate_object` wrapper. Bare
 *       CREATE TYPE crashes on re-run with `42710` duplicate-object
 *       errors and there is no `IF NOT EXISTS` form for CREATE TYPE.
 *
 *   R9  add-column-without-if-not-exists     (MEDIUM) — Wave 4-A.2
 *       `ADD COLUMN <name>` without `IF NOT EXISTS`. Same partial-
 *       replay class as R6 but for column-evolution migrations.
 *
 *   R10 alter-column-unguarded               (MEDIUM) — Wave 4-A.2
 *       `ALTER COLUMN <name> (TYPE|SET NOT NULL|DROP NOT NULL)` in a
 *       SQL chunk that does not also reference `information_schema.columns`
 *       (the canonical idempotency probe). Heuristic — when the chunk
 *       has an information_schema lookup it presumes a guarded path.
 *
 *   R11 add-constraint-without-do-block      (MEDIUM) — Wave 4-A.2
 *       `ADD CONSTRAINT <name> (FOREIGN KEY|UNIQUE|CHECK)` not wrapped
 *       in `DO $$ BEGIN ... EXCEPTION WHEN duplicate_object`. PostgreSQL
 *       has no `IF NOT EXISTS` for ADD CONSTRAINT, so the DO/EXCEPTION
 *       idiom is the canonical replayability shape.
 *
 *   R12 drop-table-without-if-exists         (CRITICAL) — Wave 4-A.2
 *       Subset of R1: `DROP TABLE <name>` without `IF EXISTS`. R1
 *       already covers the destructive-marker requirement; R12 narrows
 *       the missing-IF-EXISTS branch to a separate, more-actionable
 *       diagnostic so authors get a clearer "you forgot IF EXISTS" hint
 *       distinct from "you forgot the DESTRUCTIVE marker".
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
import { relative, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

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

export interface Violation {
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

interface SqlStructuralToken {
  readonly kind: 'word' | 'quoted-identifier' | 'symbol';
  readonly value: string;
  readonly start: number;
}

/**
 * Tokenise only SQL structure that can participate in a CREATE routine
 * declaration. String literals, dollar-quoted routine bodies, and comments are
 * deliberately skipped: text inside them is not a declaration option.
 */
function tokenizeSqlStructure(sql: string): readonly SqlStructuralToken[] {
  const tokens: SqlStructuralToken[] = [];
  let i = 0;

  while (i < sql.length) {
    const ch = sql.charAt(i);
    const next = sql.charAt(i + 1);

    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    if (ch === '-' && next === '-') {
      const eol = sql.indexOf('\n', i + 2);
      i = eol === -1 ? sql.length : eol + 1;
      continue;
    }

    if (ch === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql.charAt(i) === '/' && sql.charAt(i + 1) === '*') {
          depth++;
          i += 2;
        } else if (sql.charAt(i) === '*' && sql.charAt(i + 1) === '/') {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      continue;
    }

    if (ch === "'") {
      i++;
      while (i < sql.length) {
        if (sql.charAt(i) === "'" && sql.charAt(i + 1) === "'") {
          i += 2;
        } else if (sql.charAt(i) === "'") {
          i++;
          break;
        } else if (sql.charAt(i) === '\\' && i + 1 < sql.length) {
          i += 2;
        } else {
          i++;
        }
      }
      continue;
    }

    if (ch === '$') {
      const delimiter = sql.slice(i).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/)?.[0];
      if (delimiter !== undefined) {
        const closing = sql.indexOf(delimiter, i + delimiter.length);
        i = closing === -1 ? sql.length : closing + delimiter.length;
        continue;
      }
    }

    if (ch === '"') {
      const start = i;
      let value = '';
      i++;
      while (i < sql.length) {
        if (sql.charAt(i) === '"' && sql.charAt(i + 1) === '"') {
          value += '"';
          i += 2;
        } else if (sql.charAt(i) === '"') {
          i++;
          break;
        } else {
          value += sql.charAt(i);
          i++;
        }
      }
      tokens.push({ kind: 'quoted-identifier', value: value.toLowerCase(), start });
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      const start = i;
      i++;
      while (i < sql.length && /[A-Za-z0-9_$]/.test(sql.charAt(i))) i++;
      tokens.push({ kind: 'word', value: sql.slice(start, i).toLowerCase(), start });
      continue;
    }

    tokens.push({ kind: 'symbol', value: ch, start: i });
    i++;
  }

  return tokens;
}

function isSqlWord(token: SqlStructuralToken | undefined, value: string): boolean {
  return token?.kind === 'word' && token.value === value;
}

function isSearchPathIdentifier(token: SqlStructuralToken | undefined): boolean {
  return (
    (token?.kind === 'word' || token?.kind === 'quoted-identifier') && token.value === 'search_path'
  );
}

/**
 * Offsets of `SET search_path` clauses that belong to an `ALTER FUNCTION` /
 * `ALTER PROCEDURE` statement.
 *
 * WHY this exists alongside {@link routineConfigurationSetOffsets}: that helper
 * recognises the CREATE spelling of the routine configuration option, but the
 * same option is equally settable afterwards. `ALTER FUNCTION f() SET
 * search_path TO s` pins the routine's execution environment and touches no
 * session state at all. It is in fact the only way to pin a routine to a schema
 * name known only at migration time (`current_schema()` under per-tenant
 * fan-out), because the CREATE spelling needs the schema as a literal. R4 exists
 * to catch session contamination; flagging a routine attribute as contamination
 * pushes authors toward leaving routines unpinned, which is the state that
 * actually breaks — an unpinned trigger body resolves its own tables through the
 * caller's search_path.
 *
 * This works on raw text rather than the structural tokenizer because the clause
 * is usually assembled inside `format(...)` and run with EXECUTE, and the
 * tokenizer deliberately skips string literals. `[^;]*?` keeps the match inside
 * one statement, so a standalone `SET search_path` after a semicolon is still
 * reported.
 */
function alterRoutineConfigurationSetOffsets(sql: string): ReadonlySet<number> {
  const re =
    /\bALTER\s+(?:FUNCTION|PROCEDURE)\b[^;]*?(\bSET\s+(?:"search_path"|search_path)\s*(?:=|TO)\s)/gi;
  const offsets = new Set<number>();
  let match: RegExpExecArray | null;
  while ((match = re.exec(sql)) !== null) {
    const clause = match[1];
    if (clause === undefined) continue;
    // Group 1 is anchored at the end of the whole match.
    offsets.add(match.index + match[0].length - clause.length);
    if (match.index === re.lastIndex) re.lastIndex++;
  }
  return offsets;
}

function routineConfigurationSetOffsets(sql: string): ReadonlySet<number> {
  const tokens = tokenizeSqlStructure(sql);
  const allowedOffsets = new Set<number>();
  let statementStart = 0;

  for (let boundary = 0; boundary <= tokens.length; boundary++) {
    if (boundary < tokens.length && tokens[boundary]?.value !== ';') continue;

    const statement = tokens.slice(statementStart, boundary);
    statementStart = boundary + 1;
    if (!isSqlWord(statement[0], 'create')) continue;

    let routineKeywordIndex = 1;
    if (
      isSqlWord(statement[routineKeywordIndex], 'or') &&
      isSqlWord(statement[routineKeywordIndex + 1], 'replace')
    ) {
      routineKeywordIndex += 2;
    }
    if (
      !isSqlWord(statement[routineKeywordIndex], 'function') &&
      !isSqlWord(statement[routineKeywordIndex], 'procedure')
    ) {
      continue;
    }

    const argumentsOpenIndex = statement.findIndex(
      (token, index) => index > routineKeywordIndex && token.value === '(',
    );
    if (argumentsOpenIndex === -1) continue;

    let parenthesisDepth = 0;
    let argumentsCloseIndex = -1;
    for (let index = argumentsOpenIndex; index < statement.length; index++) {
      if (statement[index]?.value === '(') parenthesisDepth++;
      if (statement[index]?.value === ')') {
        parenthesisDepth--;
        if (parenthesisDepth === 0) {
          argumentsCloseIndex = index;
          break;
        }
      }
    }
    if (argumentsCloseIndex === -1) continue;

    parenthesisDepth = 0;
    for (let index = argumentsCloseIndex + 1; index < statement.length; index++) {
      const token = statement[index];
      if (token === undefined) continue;
      if (token?.value === '(') {
        parenthesisDepth++;
        continue;
      }
      if (token?.value === ')') {
        parenthesisDepth--;
        continue;
      }
      if (parenthesisDepth !== 0) continue;

      // SQL-standard routine bodies are structural rather than quoted. Their
      // first RETURN or BEGIN ATOMIC token ends the declaration-option region.
      if (
        isSqlWord(token, 'return') ||
        (isSqlWord(token, 'begin') && isSqlWord(statement[index + 1], 'atomic'))
      ) {
        break;
      }

      if (
        isSqlWord(token, 'set') &&
        isSearchPathIdentifier(statement[index + 1]) &&
        (statement[index + 2]?.value === '=' || isSqlWord(statement[index + 2], 'to'))
      ) {
        allowedOffsets.add(token.start);
      }
    }
  }

  return allowedOffsets;
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
    id: 'R3-create-index-not-idempotent',
    severity: 'MEDIUM',
    // CREATE [UNIQUE] INDEX must carry EITHER `CONCURRENTLY` OR `IF NOT
    // EXISTS` (or both). Bare CREATE INDEX is unsafe on two axes:
    //   - locking: takes ACCESS EXCLUSIVE on a live table; CONCURRENTLY
    //     cures it.
    //   - replayability: crashes on re-run when the index already exists;
    //     IF NOT EXISTS cures it.
    // The chunk-with-CREATE-TABLE exemption is preserved (the table is
    // empty + the chunk runs once at initial-schema time).
    scan: (sql) => {
      const hits = collectMatches(sql, /\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/i);
      return hits.filter(({ start, snippet }) => {
        // Tail of the snippet immediately after CREATE INDEX
        if (/CONCURRENTLY/i.test(snippet)) return false;
        if (/IF\s+NOT\s+EXISTS/i.test(snippet)) return false;
        // Look at the next ~80 chars after the match for the modifiers
        // (collectMatches snippet truncates to the head — re-scan a window).
        const window = sql.slice(start, start + 200);
        if (/CONCURRENTLY/i.test(window)) return false;
        if (/IF\s+NOT\s+EXISTS/i.test(window)) return false;
        const before = sql.slice(0, start);
        return !/\bCREATE\s+TABLE\b/i.test(before);
      });
    },
    message:
      'CREATE INDEX without CONCURRENTLY or IF NOT EXISTS on a pre-existing ' +
      'table. Bare CREATE INDEX takes ACCESS EXCLUSIVE (stalls writers — ' +
      'especially costly on TimescaleDB hypertables) AND crashes on replay. ' +
      'Use CREATE INDEX CONCURRENTLY IF NOT EXISTS in its own migration file ' +
      '(CONCURRENTLY cannot run inside BEGIN ... COMMIT). Initial-schema ' +
      'migrations that CREATE TABLE in the same chunk are exempt (the table ' +
      'is empty at index-creation time and the chunk replays cleanly).',
  },
  {
    id: 'R4-session-scoped-set-search-path',
    severity: 'CRITICAL',
    // Bare `SET search_path = ...` (not LOCAL) in a migration body. LOCAL
    // form is permitted; session scope contaminates the pooled connection.
    // CREATE FUNCTION/PROCEDURE uses the same spelling for a declaration
    // option that pins the routine's execution environment. That option is
    // local to the routine and must not be confused with a standalone SET.
    scan: (sql) => {
      const routineConfigurationOffsets = routineConfigurationSetOffsets(sql);
      const alterRoutineOffsets = alterRoutineConfigurationSetOffsets(sql);
      return collectMatches(
        sql,
        /\bSET\s+(?!LOCAL\b)(?:SESSION\s+)?(?:"search_path"|search_path)\s*(?:=|TO)\s/i,
      ).filter(
        ({ start }) => !routineConfigurationOffsets.has(start) && !alterRoutineOffsets.has(start),
      );
    },
    message:
      'session-scoped `SET search_path` in migration body. Use `SET LOCAL ' +
      "search_path = '<schema>', public;` — LOCAL scope releases on COMMIT. " +
      'The session-scoped form is the 2026-04-07 split-brain incident class ' +
      '(DATA-HIGH-003 precedent).',
  },
  {
    id: 'R5-overbroad-exception-catch',
    severity: 'HIGH',
    // EXCEPTION WHEN others THEN NULL — swallows security failures.
    scan: (sql) => collectMatches(sql, /\bEXCEPTION\s+WHEN\s+others\s+THEN\s+NULL\b/i),
    message:
      'overbroad PL/pgSQL EXCEPTION catch — `WHEN others THEN NULL` masks ' +
      'security failures, timeouts, and deadlocks alike. Narrow to the ' +
      'specific exception class (e.g. `WHEN duplicate_object THEN NULL`).',
  },
  {
    id: 'R6-create-table-without-if-not-exists',
    severity: 'MEDIUM',
    // CREATE TABLE <name> (not IF NOT EXISTS, not session-scoped
    // TEMP / UNLOGGED variants — those vanish at session end so
    // the cross-migration idempotency concern does not apply). Skips
    // CREATE TEMP TABLE because partial-state DBs cannot retain a
    // session-scoped table across migration runs.
    scan: (sql) =>
      collectMatches(
        sql,
        /\bCREATE\s+(?!TEMP(?:ORARY)?\s+|UNLOGGED\s+)TABLE\s+(?!IF\s+NOT\s+EXISTS\b)["\w.]+/i,
      ),
    message:
      'CREATE TABLE without IF NOT EXISTS is non-idempotent — replays on ' +
      'partial-state DBs (a previous migration ran halfway and failed) crash ' +
      'on the second pass with `42P07` relation-already-exists. Use ' +
      '`CREATE TABLE IF NOT EXISTS <name>`. The migration runner replays ' +
      'on every cold start until the migration ledger logs success, so ' +
      'idempotency is load-bearing, not optional.',
  },
  {
    id: 'R8-create-type-without-do-block',
    severity: 'MEDIUM',
    // CREATE TYPE ... AS ENUM outside of a DO $$ EXCEPTION wrap. PG has
    // no IF NOT EXISTS for CREATE TYPE so the canonical idempotency
    // shape is `DO $$ BEGIN CREATE TYPE ...; EXCEPTION WHEN duplicate_object
    // THEN NULL; END $$`. Match every CREATE TYPE then exclude the ones
    // wrapped in a same-statement DO block.
    scan: (sql) => {
      const hits = collectMatches(sql, /\bCREATE\s+TYPE\s+["\w.]+\s+AS\s+ENUM\b/i);
      return hits.filter(({ start }) => {
        // Walk backwards from the match looking for a DO $$ BEGIN within
        // the most recent block boundary (no intervening END $$).
        const window = sql.slice(Math.max(0, start - 400), start);
        // Reject when the window contains an unclosed DO $$ BEGIN block.
        const doOpens = (window.match(/\bDO\s*\$\$\s*BEGIN\b/gi) ?? []).length;
        const doCloses = (window.match(/\bEND\s*\$\$/gi) ?? []).length;
        return doOpens <= doCloses;
      });
    },
    message:
      'CREATE TYPE ... AS ENUM outside `DO $$ BEGIN ... EXCEPTION WHEN ' +
      'duplicate_object THEN NULL; END $$;` block. PostgreSQL has no IF NOT ' +
      'EXISTS form for CREATE TYPE — the DO/EXCEPTION wrap is the canonical ' +
      'idempotency idiom. Bare CREATE TYPE crashes on replay with `42710`.',
  },
  {
    id: 'R9-add-column-without-if-not-exists',
    severity: 'MEDIUM',
    // ADD COLUMN <name> without IF NOT EXISTS. Same partial-replay class
    // as R6 but on column-evolution migrations. Match-then-filter so we
    // also accept `ADD COLUMN IF NOT EXISTS "..."` with quoted identifier.
    scan: (sql) => collectMatches(sql, /\bADD\s+COLUMN\s+(?!IF\s+NOT\s+EXISTS\b)["\w]+/i),
    message:
      'ADD COLUMN without IF NOT EXISTS is non-idempotent. On replay (the ' +
      'migration runner re-runs migrations until the ledger logs success) ' +
      'PostgreSQL crashes with `42701` column-already-exists. Use ' +
      '`ALTER TABLE <t> ADD COLUMN IF NOT EXISTS <c> <type>` (PG ≥ 9.6).',
  },
  {
    id: 'R10-alter-column-unguarded',
    severity: 'MEDIUM',
    // ALTER COLUMN <name> (TYPE | SET NOT NULL | DROP NOT NULL) in a SQL
    // chunk that does not also reference information_schema.columns
    // (the canonical pre-check for "is this column already in the target
    // shape"). Heuristic — when the chunk has the lookup we trust the
    // author's idempotency probe.
    scan: (sql) => {
      const hits = collectMatches(
        sql,
        /\bALTER\s+COLUMN\s+["\w]+\s+(TYPE|SET\s+NOT\s+NULL|DROP\s+NOT\s+NULL)\b/i,
      );
      // If the SAME chunk references information_schema.columns, presume
      // a guarded path and exempt every hit in this chunk.
      if (/\binformation_schema\.columns\b/i.test(sql)) return [];
      // Also accept when wrapped in DO $$ EXCEPTION blocks (matches R8 logic).
      return hits.filter(({ start }) => {
        const window = sql.slice(Math.max(0, start - 400), start);
        const doOpens = (window.match(/\bDO\s*\$\$\s*BEGIN\b/gi) ?? []).length;
        const doCloses = (window.match(/\bEND\s*\$\$/gi) ?? []).length;
        return doOpens <= doCloses;
      });
    },
    message:
      'ALTER COLUMN (TYPE | SET NOT NULL | DROP NOT NULL) without an ' +
      '`information_schema.columns` pre-check or `DO $$ EXCEPTION` wrap. ' +
      'On replay the second pass either crashes (TYPE conversion mismatch) ' +
      'or is a silent no-op when the column already has the target shape; ' +
      'either is reviewer-trap. Wrap in a `DO $$ BEGIN IF EXISTS (SELECT 1 ' +
      'FROM information_schema.columns WHERE ...) THEN ... END IF; END $$` ' +
      'block, or guard with explicit data_type check.',
  },
  {
    id: 'R11-add-constraint-without-do-block',
    severity: 'MEDIUM',
    // ADD CONSTRAINT <name> (FOREIGN KEY|UNIQUE|CHECK) outside an
    // idempotency guard. PG has no IF NOT EXISTS for ADD CONSTRAINT, so
    // either a DO $$ EXCEPTION wrap or an explicit pg_constraint/conname
    // existence probe is required.
    scan: (sql) => {
      const hits = collectMatches(
        sql,
        /\bADD\s+CONSTRAINT\s+["\w]+\s+(FOREIGN\s+KEY|UNIQUE|CHECK)\b/i,
      );
      return hits.filter(({ start }) => {
        const guardWindow = sql.slice(Math.max(0, start - 800), start);
        if (/\bpg_constraint\b/i.test(guardWindow) && /\bconname\b/i.test(guardWindow)) {
          return false;
        }
        const window = sql.slice(Math.max(0, start - 400), start);
        const doOpens = (window.match(/\bDO\s*\$\$\s*BEGIN\b/gi) ?? []).length;
        const doCloses = (window.match(/\bEND\s*\$\$/gi) ?? []).length;
        return doOpens <= doCloses;
      });
    },
    message:
      'ADD CONSTRAINT (FOREIGN KEY | UNIQUE | CHECK) outside an idempotency ' +
      'guard. PG has no IF NOT EXISTS form for ADD CONSTRAINT — use a ' +
      '`DO $$ BEGIN ... EXCEPTION WHEN duplicate_object THEN NULL; END $$;` ' +
      'block or an explicit pg_constraint/conname existence probe. Bare ' +
      'ADD CONSTRAINT crashes on replay with `42710` duplicate-object.',
  },
  {
    id: 'R12-drop-table-without-if-exists',
    severity: 'CRITICAL',
    // DROP TABLE <name> without IF EXISTS. R1 already flags this as part
    // of its destructive-marker rule; R12 narrows the diagnostic so
    // authors see a clearer "you forgot IF EXISTS" hint distinct from
    // "you forgot the DESTRUCTIVE marker". Both fire on the same row —
    // intentional belt-and-suspenders.
    scan: (sql) => collectMatches(sql, /\bDROP\s+TABLE\s+(?!IF\s+EXISTS\b)["\w.]+/i),
    message:
      'DROP TABLE without IF EXISTS — non-idempotent and combines poorly ' +
      'with partial-replay scenarios. Use `DROP TABLE IF EXISTS <name>` AND ' +
      'add a `-- DESTRUCTIVE: <rollback-reference>` marker on the same ' +
      'statement (R1 covers the marker requirement separately).',
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

function scanSqlChunks(
  relPath: string,
  source: string,
  chunks: readonly { sql: string; offset: number }[],
): Violation[] {
  const violations: Violation[] = [];
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

/** Scan an in-memory SQL migration through the same rules used by the CLI. */
export function scanMigrationSql(sql: string): readonly Violation[] {
  return scanSqlChunks('<inline migration>', sql, [{ sql, offset: 0 }]);
}

function scanMigrationFile(relPath: string): Violation[] {
  const abs = resolve(REPO_ROOT, relPath);
  if (!existsSync(abs)) return [];
  const source = readFileSync(abs, 'utf8');
  const chunks: { sql: string; offset: number }[] = relPath.toLowerCase().endsWith('.sql')
    ? [{ sql: source, offset: 0 }]
    : [...extractSqlChunks(source)];
  return scanSqlChunks(relPath, source, chunks);
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
  // Staged mode (local dev) — scan ADDED migrations only. Once a migration
  // has landed on any branch, its content is frozen at the DB level (TypeORM
  // records ran migrations by name and refuses to re-execute), so
  // MODIFICATIONS to an existing migration are dead code at the prod level.
  // Keeping the local gate to A-only mirrors the range semantics and avoids
  // penalising the `git add <existing-migration>` flow when a developer
  // fixes a typo in an already-run file.
  return run('git diff --cached --name-only --diff-filter=A')
    .split('\n')
    .filter((f) => f.length > 0 && isMigrationFile(f));
}

function rangeMigrationFiles(baseRef: string, headRef: string): string[] {
  // Range mode (CI PR) — ADDED only. Long-lived feature branches accumulate
  // many `M` entries for migrations that landed on main after the branch
  // diverged; flagging those would make the gate a false-positive factory
  // on every multi-week PR. The architectural invariant being protected is
  // "new migrations must ship with the delta-safety envelope" — pre-existing
  // migrations are grandfathered because amending them is forbidden under
  // the force-push ban (and even if someone tried, TypeORM would not re-run
  // the amended body). If a brand-new migration is genuinely suspect, it
  // appears in the A-filter and is caught here.
  return run(`git diff ${baseRef}..${headRef} --name-only --diff-filter=A`)
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
  console.error('R1-R5: original delta-safety rules.');
  console.error('R6-R12 (Wave 4-A.2): idempotency-replayability rules.');
  console.error('Grandfather policy: this gate only runs on migrations ADDED');
  console.error('in the current change set. Existing migrations are exempt');
  console.error('(amending is forbidden under the force-push ban; replays are');
  console.error('blocked by the ledger).');
}

function main(): void {
  const [, , rawModeFlag, ...args] = process.argv;
  // Default mode for `npm run gates:all` / bare-shell invocations.
  // CI always supplies --mode=range explicitly.
  const modeFlag = rawModeFlag ?? '--mode=staged';
  if (!rawModeFlag) {
    console.error('[migration-sql-lint] no --mode supplied; defaulting to --mode=staged.');
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

if (require.main === module) main();
