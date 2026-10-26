/**
 * ADR-053 — the migration-sql-lint rules for `ADD COLUMN` on PostgreSQL 16.
 *
 * A NOT NULL column with a constant DEFAULT is a catalog-only change on PG16
 * (the value is stored in pg_attribute, legacy rows are not touched; proven by
 * libs/migration-harness/src/__tests__/pg16-constant-default-catalog-only.integration.spec.ts).
 * Two things keep that exemption honest, and each is a rule here:
 *
 *   R13-add-column-rewriting-default  (per chunk)
 *     An ADD on a table the chunk does not create, which PostgreSQL rewrites or
 *     scans under ACCESS EXCLUSIVE: `GENERATED … STORED`, an identity or serial
 *     type, a DEFAULT outside the Decision-1 allowlist (an interpolated `${…}`
 *     DEFAULT counts as outside), or NOT NULL DEFAULT with an inline CHECK,
 *     REFERENCES, UNIQUE or PRIMARY KEY. And every `CREATE DOMAIN`: a domain
 *     with constraints forces a rewrite, and the gate cannot see a domain's
 *     definition from the ADD clause (ADR-053 Decision 2).
 *
 *   R14-add-column-exemption-shape  (per file)
 *     A file holding a Decision-1 ADD (NOT NULL DEFAULT <allowlisted constant>
 *     on a table the file does not create) must have the Decision-3 shape:
 *       (a) the same-statement `-- ADR-053: <why the value is true for every
 *           existing row>` reason;
 *       (b) `SET LOCAL lock_timeout` of 2 s or less before the first ALTER TABLE
 *           of up() and of down(), and no larger, zero or unreadable value
 *           anywhere in the file;
 *       (c) every ALTER TABLE names the same literal table;
 *       (d) no statement other than SET LOCAL, a read-only SELECT, ADD COLUMN on
 *           that table and, in down(), the inverse DROP COLUMN IF EXISTS of a
 *           column the file adds; every query is a template literal the gate
 *           can read;
 *       (e) no `transaction = false` and no `withDdlSafety(`.
 *     It is file-scoped because a lock_timeout set in one `.query()` call
 *     governs the ALTER TABLE in the next one, and a per-chunk rule sees one
 *     chunk at a time.
 *
 * Whether the `-- ADR-053:` reason is true is a fact about the data; neither
 * PostgreSQL nor this gate can check it. The gate checks that it is stated.
 */

import * as ts from 'typescript';

import {
  alterTablesIn,
  createdTables,
  isAllowlistedConstantDefault,
  isCreatedTable,
  isSymbol,
  isWord,
  splitStatements,
  tokenizeSql,
  type AddColumnAction,
  type AlterTable,
  type SqlStatement,
  type SqlToken,
  type TableName,
} from './migration-sql-structure';

export interface RuleHit {
  readonly start: number;
  readonly snippet: string;
}

export interface MigrationChunk {
  readonly sql: string;
  /** Offset of the chunk in the file (the stripped text keeps every offset). */
  readonly offset: number;
}

/** One migration as the gate reads it. */
export interface MigrationFile {
  /** The file as written. */
  readonly source: string;
  /** The file with TS comments blanked to spaces (same length); a `.sql` file as is. */
  readonly text: string;
  /** Its SQL: the `.query(` template literals, or the whole `.sql` file. */
  readonly chunks: readonly MigrationChunk[];
  readonly kind: 'typeorm' | 'sql';
}

export interface ShapeHit {
  readonly offset: number;
  readonly snippet: string;
  /** `(a)`…`(e)`: which Decision-3 requirement failed, and how. */
  readonly detail: string;
}

/** The largest lock wait ADR-053 Decision 3 allows, in milliseconds. */
export const ADR_053_MAX_LOCK_TIMEOUT_MS = 2000;

const REASON_MARKER = /--[ \t]*ADR-053:[ \t]*\S/;

/** Whether PostgreSQL rewrites or scans the table to add this column. */
function rewritesOrScans(action: AddColumnAction): boolean {
  if (action.generatedOrSerial) return true;
  if (action.defaultTokens !== null && !isAllowlistedConstantDefault(action.defaultTokens)) {
    return true;
  }
  return action.notNull && action.defaultTokens !== null && action.inlineConstraint;
}

/** ADR-053 Decision 1: NOT NULL DEFAULT <allowlisted constant>, no inline constraint. */
function isDecisionOneAdd(action: AddColumnAction): boolean {
  return (
    action.notNull &&
    action.defaultTokens !== null &&
    action.defaultTokens.length > 0 &&
    !rewritesOrScans(action)
  );
}

function domainStarts(tokens: readonly SqlToken[]): readonly number[] {
  return tokens.flatMap((t, i) =>
    isWord(t, 'create') && isWord(tokens[i + 1], 'domain') ? [t.start] : [],
  );
}

/** R13 over one SQL chunk: the start of each rewriting ADD and each CREATE DOMAIN. */
export function scanRewritingAddColumns(sql: string): readonly RuleHit[] {
  const tokens = tokenizeSql(sql);
  const statements = splitStatements(sql, tokens);
  const created = createdTables(statements);
  const hits: RuleHit[] = [];
  for (const statement of statements) {
    for (const start of domainStarts(statement.tokens)) {
      hits.push({ start, snippet: sql.slice(start, statement.end).slice(0, 160) });
    }
    for (const alter of alterTablesIn(statement)) {
      if (alter.target !== null && isCreatedTable(created, alter.target)) continue;
      for (const action of alter.actions) {
        if (action.kind !== 'add-column' || !rewritesOrScans(action)) continue;
        hits.push({
          start: action.start,
          snippet: sql.slice(action.start, action.end).slice(0, 160),
        });
      }
    }
  }
  return hits.sort((a, b) => a.start - b.start);
}

type Region = 'up' | 'down' | 'file';

interface RegionRange {
  readonly region: Region;
  readonly start: number;
  readonly end: number;
}

/** The body of `up() {…}` or of `up = async () => …`. */
function methodBody(node: ts.Node): ts.Node | undefined {
  if (ts.isMethodDeclaration(node)) return node.body;
  if (!ts.isPropertyDeclaration(node) || node.initializer === undefined) return undefined;
  const { initializer } = node;
  return ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)
    ? initializer.body
    : undefined;
}

/** Every match of a global regex in `text`, with its offset. */
function matchesOf(text: string, pattern: RegExp): readonly { index: number; text: string }[] {
  const out: { index: number; text: string }[] = [];
  const re = new RegExp(pattern.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) out.push({ index: match.index, text: match[0] });
  return out;
}

/** The bodies of a TypeORM migration's up() and down(), as ranges of the file text. */
function migrationMethodRanges(text: string): readonly RegionRange[] {
  const source = ts.createSourceFile('migration.ts', text, ts.ScriptTarget.Latest, false);
  const ranges: RegionRange[] = [];
  const visit = (node: ts.Node): void => {
    const name =
      (ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node)) && ts.isIdentifier(node.name)
        ? node.name.text
        : null;
    if (name === 'up' || name === 'down') {
      const body = methodBody(node);
      if (body !== undefined) {
        ranges.push({ region: name, start: body.getStart(source), end: body.getEnd() });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return ranges;
}

/** A parsed statement placed in the file: absolute offsets and its region. */
interface PlacedStatement {
  readonly chunk: MigrationChunk;
  readonly statement: SqlStatement;
  readonly alters: readonly AlterTable[];
  readonly region: Region | null;
}

function abs(placed: PlacedStatement, localOffset: number): number {
  return placed.chunk.offset + localOffset;
}

function snippetOf(placed: PlacedStatement, from: number, to: number): string {
  return placed.chunk.sql.slice(from, to).replace(/\s+/g, ' ').trim().slice(0, 160);
}

/** Milliseconds of a lock_timeout value (`'2s'`, `'1500ms'`, `2000`), or null when unreadable. */
function lockTimeoutMs(value: readonly SqlToken[]): number | null {
  const [only] = value;
  if (value.length !== 1 || only === undefined || only.interpolated) return null;
  if (only.kind !== 'string' && only.kind !== 'number') return null;
  const match = /^\s*(\d+(?:\.\d+)?)\s*(us|ms|s|min|h|d)?\s*$/i.exec(only.value);
  if (match === null) return null;
  const factor: Readonly<Record<string, number>> = {
    us: 0.001,
    ms: 1,
    s: 1000,
    min: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  return Number(match[1]) * (factor[(match[2] ?? 'ms').toLowerCase()] ?? Number.NaN);
}

interface LockTimeoutSetting {
  readonly start: number;
  readonly end: number;
  readonly local: boolean;
  readonly ms: number | null;
}

/** Every lock_timeout this statement sets: `SET [LOCAL|SESSION] lock_timeout …` or `set_config('lock_timeout', …)`. */
function lockTimeoutSettings(tokens: readonly SqlToken[]): readonly LockTimeoutSetting[] {
  const settings: LockTimeoutSetting[] = [];
  const first = tokens[0];
  if (isWord(first, 'set')) {
    const local = isWord(tokens[1], 'local');
    const k = isWord(tokens[1], 'local', 'session') ? 2 : 1;
    if (
      isWord(tokens[k], 'lock_timeout') &&
      (isSymbol(tokens[k + 1], '=') || isWord(tokens[k + 1], 'to'))
    ) {
      const last = tokens[tokens.length - 1];
      settings.push({
        start: first?.start ?? 0,
        end: last?.end ?? 0,
        local,
        ms: lockTimeoutMs(tokens.slice(k + 2)),
      });
    }
  }
  tokens.forEach((t, i) => {
    const name = tokens[i + 2];
    if (!isWord(t, 'set_config') || !isSymbol(tokens[i + 1], '(')) return;
    if (name === undefined || name.kind !== 'string' || name.value !== 'lock_timeout') return;
    const value = tokens[i + 4];
    settings.push({
      start: t.start,
      end: (tokens[i + 5] ?? t).end,
      local: false,
      ms: isSymbol(tokens[i + 3], ',') && value !== undefined ? lockTimeoutMs([value]) : null,
    });
  });
  return settings;
}

function isWithinBound(ms: number | null): boolean {
  return ms !== null && ms > 0 && ms <= ADR_053_MAX_LOCK_TIMEOUT_MS;
}

/** (d): whether a statement is one the exemption allows. */
function isAllowedStatement(
  placed: PlacedStatement,
  target: TableName,
  addedColumns: ReadonlySet<string>,
): boolean {
  const { tokens } = placed.statement;
  const [first] = tokens;
  if (tokens.some((t) => t.kind === 'interpolation' || t.interpolated)) {
    // An interpolated ALTER TABLE target is (c)'s finding; anything else that
    // interpolates is SQL the gate cannot read.
    const onlyTarget =
      placed.alters.length === 1 &&
      placed.alters[0]?.target?.interpolated === true &&
      placed.alters[0].actions.every((action) =>
        action.tokens.every((t) => t.kind !== 'interpolation' && !t.interpolated),
      );
    if (!onlyTarget) return false;
  }
  if (isWord(first, 'set')) return isWord(tokens[1], 'local');
  if (isWord(first, 'select')) {
    return !tokens.some(
      (t, i) =>
        isWord(t, 'into') ||
        (isWord(t, 'for') && isWord(tokens[i + 1], 'update', 'share', 'no', 'key')),
    );
  }
  if (!isWord(first, 'alter') || placed.alters.length !== 1) return false;
  const [alter] = placed.alters;
  if (alter === undefined || alter.start !== first?.start) return false;
  return alter.actions.every(
    (action) =>
      action.kind === 'add-column' ||
      (action.kind === 'drop-column' &&
        action.ifExists &&
        placed.region === 'down' &&
        alter.target?.key === target.key &&
        addedColumns.has(action.column)),
  );
}

/**
 * R14 over one migration file. Chunk offsets are file offsets; up() and down()
 * are read from the file as written, and the TS-level checks ((d)'s unreadable
 * queries, (e)) from the comment-blanked text, so a comment cannot trip them.
 */
export function inspectExemptionShape(migration: MigrationFile): readonly ShapeHit[] {
  const { source, text, chunks, kind } = migration;
  const ranges: readonly RegionRange[] =
    kind === 'sql'
      ? [{ region: 'file', start: 0, end: source.length }]
      : migrationMethodRanges(source);
  const placed: PlacedStatement[] = chunks.flatMap((chunk) =>
    splitStatements(chunk.sql, tokenizeSql(chunk.sql)).map((statement) => {
      const at = chunk.offset + (statement.tokens[0]?.start ?? statement.start);
      const range = ranges.find((r) => at >= r.start && at < r.end);
      return { chunk, statement, alters: alterTablesIn(statement), region: range?.region ?? null };
    }),
  );

  const created = createdTables(placed.map((p) => p.statement));
  const decisionOne = placed.flatMap((p) =>
    p.alters.flatMap((alter) =>
      alter.target !== null && !isCreatedTable(created, alter.target)
        ? alter.actions.flatMap((action) =>
            action.kind === 'add-column' && isDecisionOneAdd(action) ? [{ p, alter, action }] : [],
          )
        : [],
    ),
  );
  const [primary] = decisionOne;
  if (primary === undefined || primary.alter.target === null) return [];
  const target = primary.alter.target;
  const hits: ShapeHit[] = [];
  const hit = (p: PlacedStatement, from: number, to: number, detail: string): void => {
    hits.push({ offset: abs(p, from), snippet: snippetOf(p, from, to), detail });
  };

  // (a) the stated reason, in the statement that adds the column.
  for (const { p, action } of decisionOne) {
    const statementText = p.chunk.sql.slice(p.statement.start, p.statement.end);
    if (!REASON_MARKER.test(statementText)) {
      hit(p, action.start, action.end, '(a) no same-statement `-- ADR-053: <reason>` comment.');
    }
  }

  // (b) the lock wait: bounded everywhere, and set before the first ALTER TABLE per method.
  for (const p of placed) {
    for (const setting of lockTimeoutSettings(p.statement.tokens)) {
      if (!isWithinBound(setting.ms)) {
        hit(
          p,
          setting.start,
          setting.end,
          '(b) lock_timeout above 2s, zero (no limit) or unreadable.',
        );
      }
    }
  }
  const firstAlterByRegion = new Map<Region | null, { p: PlacedStatement; start: number }>();
  for (const p of placed) {
    const [alter] = p.alters;
    if (alter !== undefined && !firstAlterByRegion.has(p.region)) {
      firstAlterByRegion.set(p.region, { p, start: alter.start });
    }
  }
  for (const [region, first] of firstAlterByRegion) {
    if (region === null) {
      hit(first.p, first.start, first.p.statement.end, '(b) ALTER TABLE outside up() and down().');
      continue;
    }
    const firstAt = abs(first.p, first.start);
    const bounded = placed.some(
      (p) =>
        p.region === region &&
        lockTimeoutSettings(p.statement.tokens).some(
          (setting) =>
            setting.local && isWithinBound(setting.ms) && abs(p, setting.start) < firstAt,
        ),
    );
    if (!bounded) {
      hit(
        first.p,
        first.start,
        first.p.statement.end,
        `(b) no SET LOCAL lock_timeout <= 2s before the first ALTER TABLE of ${region === 'file' ? 'the file' : `${region}()`}.`,
      );
    }
  }

  // (c) one literal table.
  for (const p of placed) {
    for (const alter of p.alters) {
      if (alter.target === null || alter.target.interpolated || alter.target.key !== target.key) {
        hit(
          p,
          alter.start,
          p.statement.end,
          `(c) ALTER TABLE does not name the literal table ${target.key}.`,
        );
      }
    }
  }

  // (d) nothing else.
  const addedColumns = new Set(
    placed.flatMap((p) =>
      p.alters
        .filter((alter) => alter.target?.key === target.key)
        .flatMap((alter) =>
          alter.actions.flatMap((action) => (action.kind === 'add-column' ? [action.column] : [])),
        ),
    ),
  );
  for (const p of placed) {
    if (!isAllowedStatement(p, target, addedColumns)) {
      const from = p.statement.tokens[0]?.start ?? p.statement.start;
      hit(
        p,
        from,
        p.statement.end,
        `(d) only SET LOCAL, read-only SELECT, ADD COLUMN on ${target.key} and its inverse DROP COLUMN IF EXISTS in down() are allowed.`,
      );
    }
  }
  if (kind === 'typeorm') {
    for (const match of matchesOf(text, /\b\w+\.query\(\s*(?![\s`])/)) {
      hits.push({
        offset: match.index,
        snippet: text
          .slice(match.index, match.index + 80)
          .replace(/\s+/g, ' ')
          .trim(),
        detail: '(d) a .query() whose SQL is not a template literal cannot be read by the gate.',
      });
    }
    // (e) one transaction, no envelope that overrides the bound or the search_path.
    for (const match of matchesOf(text, /\btransaction\s*=\s*false\b|\bwithDdlSafety\s*\(/)) {
      hits.push({
        offset: match.index,
        snippet: match.text,
        detail: '(e) the exemption runs in the orchestrator transaction without withDdlSafety.',
      });
    }
  }
  return hits.sort((a, b) => a.offset - b.offset);
}
