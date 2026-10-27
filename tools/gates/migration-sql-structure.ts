/**
 * The SQL structure the ADR-053 `ADD COLUMN` rules of migration-sql-lint read:
 * tokens, statements, the actions of an `ALTER TABLE`, and the Decision-1
 * allowlist of defaults that PostgreSQL 16 evaluates once and stores in the
 * catalog.
 *
 * WHY a tokenizer and not the gate's regexes: whether an `ADD COLUMN` rewrites
 * the table depends on which DEFAULT belongs to which column. A regex cannot
 * tell `numeric(10,2) NOT NULL DEFAULT 0, ADD COLUMN b uuid DEFAULT
 * gen_random_uuid()` apart from one column with two defaults, and it reads
 * `ADD COLUMN` inside a string literal as SQL. The tokens here keep string
 * literals, quoted identifiers and the migration's own `${…}` interpolations
 * whole, and track parenthesis depth, so a clause is exactly one column.
 *
 * Dollar-quoted bodies (`DO $$ … $$`, routine bodies) are tokenized as SQL in
 * their own bounds: an `ALTER TABLE` inside a DO block is still seen, and an
 * unbalanced quote inside a body cannot swallow the statements after it.
 *
 * Pure: it reads nothing and knows no rule. migration-add-column-rules.ts
 * decides what the structure means.
 */

export type SqlTokenKind =
  | 'word'
  | 'quoted-identifier'
  | 'string'
  | 'number'
  | 'interpolation'
  | 'dollar-quote'
  | 'parameter'
  | 'symbol';

export interface SqlToken {
  readonly kind: SqlTokenKind;
  /** Lower-cased for a word; the unquoted text for a string or quoted identifier. */
  readonly value: string;
  readonly start: number;
  readonly end: number;
  /** A string literal whose text holds a `${…}` interpolation of the migration. */
  readonly interpolated: boolean;
}

export interface SqlStatement {
  readonly tokens: readonly SqlToken[];
  /** Raw text range: just after the previous `;` (or the chunk start) to this `;`. */
  readonly start: number;
  readonly end: number;
}

export interface TableName {
  /** Dot-joined parts: a word lower-cased, a quoted identifier as written. */
  readonly key: string;
  readonly baseName: string;
  readonly qualified: boolean;
  readonly interpolated: boolean;
}

export interface AddColumnAction {
  readonly kind: 'add-column';
  readonly start: number;
  readonly end: number;
  readonly column: string;
  readonly columnInterpolated: boolean;
  readonly notNull: boolean;
  /** The DEFAULT expression's tokens, or null when the clause declares none. */
  readonly defaultTokens: readonly SqlToken[] | null;
  /** A serial type, an identity, or `GENERATED … STORED`: always a rewrite. */
  readonly generatedOrSerial: boolean;
  /** An inline CHECK, REFERENCES, UNIQUE or PRIMARY KEY. */
  readonly inlineConstraint: boolean;
  readonly tokens: readonly SqlToken[];
}

export interface DropColumnAction {
  readonly kind: 'drop-column';
  readonly start: number;
  readonly end: number;
  readonly column: string;
  readonly ifExists: boolean;
  readonly tokens: readonly SqlToken[];
}

export interface OtherAction {
  readonly kind: 'other';
  readonly start: number;
  readonly end: number;
  readonly tokens: readonly SqlToken[];
}

export type AlterAction = AddColumnAction | DropColumnAction | OtherAction;

export interface AlterTable {
  readonly start: number;
  readonly target: TableName | null;
  readonly actions: readonly AlterAction[];
}

const DOLLAR_QUOTE = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/;
const SERIAL_TYPES = new Set([
  'serial',
  'serial2',
  'serial4',
  'serial8',
  'smallserial',
  'bigserial',
]);
const ADD_CONSTRAINT_STARTS = new Set([
  'constraint',
  'primary',
  'unique',
  'check',
  'foreign',
  'exclude',
]);
const INLINE_CONSTRAINTS = new Set(['check', 'references', 'unique', 'primary']);
/** Words that end a DEFAULT expression at depth 0 (a column-constraint keyword). */
const DEFAULT_TERMINATORS = new Set([
  'constraint',
  'check',
  'references',
  'unique',
  'primary',
  'generated',
  'collate',
  'deferrable',
  'initially',
]);

function token(
  kind: SqlTokenKind,
  value: string,
  start: number,
  end: number,
  interpolated = false,
): SqlToken {
  return { kind, value, start, end, interpolated };
}

/** The dollar-quote delimiter (`$$`, `$body$`) that starts at `start`. */
function dollarDelimiterAt(sql: string, start: number, limit: number): string {
  const match = DOLLAR_QUOTE.exec(sql.slice(start, limit));
  return match === null ? '$$' : match[0];
}

/** The length of the numeric literal that starts at `start` (at least 1). */
function numberLengthAt(sql: string, start: number, limit: number): number {
  const match = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(sql.slice(start, limit));
  return match === null ? 1 : match[0].length;
}

/** The end (exclusive) of the `${…}` interpolation starting at `start`. */
function interpolationEnd(sql: string, start: number, limit: number): number {
  let depth = 0;
  for (let i = start + 1; i < limit; i++) {
    if (sql.charAt(i) === '{') depth++;
    if (sql.charAt(i) === '}' && --depth === 0) return i + 1;
  }
  return limit;
}

function tokenizeRange(sql: string, from: number, to: number, out: SqlToken[]): void {
  let i = from;
  while (i < to) {
    const ch = sql.charAt(i);
    const next = sql.charAt(i + 1);
    if (/\s/.test(ch)) {
      i++;
    } else if (ch === '-' && next === '-') {
      const eol = sql.indexOf('\n', i);
      i = eol === -1 || eol > to ? to : eol + 1;
    } else if (ch === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < to && depth > 0) {
        if (sql.startsWith('/*', i)) {
          depth++;
          i += 2;
        } else if (sql.startsWith('*/', i)) {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
    } else if (ch === '$' && next === '{') {
      const end = interpolationEnd(sql, i, to);
      out.push(token('interpolation', sql.slice(i, end), i, end));
      i = end;
    } else if (ch === '$' && DOLLAR_QUOTE.test(sql.slice(i, to))) {
      const delimiter = dollarDelimiterAt(sql, i, to);
      const close = sql.indexOf(delimiter, i + delimiter.length);
      const bodyEnd = close === -1 || close >= to ? to : close;
      out.push(token('dollar-quote', delimiter, i, i + delimiter.length));
      tokenizeRange(sql, i + delimiter.length, bodyEnd, out);
      if (bodyEnd < to) {
        out.push(token('dollar-quote', delimiter, bodyEnd, bodyEnd + delimiter.length));
      }
      i = bodyEnd < to ? bodyEnd + delimiter.length : to;
    } else if (ch === '$' && /[0-9]/.test(next)) {
      let end = i + 1;
      while (end < to && /[0-9]/.test(sql.charAt(end))) end++;
      out.push(token('parameter', sql.slice(i, end), i, end));
      i = end;
    } else if (ch === "'" || ch === '"') {
      let end = i + 1;
      let value = '';
      while (end < to) {
        if (sql.charAt(end) === ch && sql.charAt(end + 1) === ch) {
          value += ch;
          end += 2;
        } else if (sql.charAt(end) === ch) {
          end++;
          break;
        } else {
          value += sql.charAt(end);
          end++;
        }
      }
      const kind = ch === "'" ? 'string' : 'quoted-identifier';
      out.push(token(kind, value, i, end, value.includes('${')));
      i = end;
    } else if (/[A-Za-z_]/.test(ch)) {
      let end = i + 1;
      while (end < to && /[A-Za-z0-9_]/.test(sql.charAt(end))) end++;
      out.push(token('word', sql.slice(i, end).toLowerCase(), i, end));
      i = end;
    } else if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(next))) {
      const end = i + numberLengthAt(sql, i, to);
      out.push(token('number', sql.slice(i, end), i, end));
      i = end;
    } else if (ch === ':' && next === ':') {
      out.push(token('symbol', '::', i, i + 2));
      i += 2;
    } else {
      out.push(token('symbol', ch, i, i + 1));
      i++;
    }
  }
}

/** The structural tokens of `sql`; comments are skipped, literals kept whole. */
export function tokenizeSql(sql: string): readonly SqlToken[] {
  const out: SqlToken[] = [];
  tokenizeRange(sql, 0, sql.length, out);
  return out;
}

export function isWord(t: SqlToken | undefined, ...values: readonly string[]): boolean {
  return t !== undefined && t.kind === 'word' && values.includes(t.value);
}

export function isSymbol(t: SqlToken | undefined, value: string): boolean {
  return t !== undefined && t.kind === 'symbol' && t.value === value;
}

/** Statements split on `;`; a statement with no tokens (a lone comment) is dropped. */
export function splitStatements(sql: string, tokens: readonly SqlToken[]): readonly SqlStatement[] {
  const statements: SqlStatement[] = [];
  let start = 0;
  let current: SqlToken[] = [];
  for (const t of tokens) {
    if (isSymbol(t, ';')) {
      if (current.length > 0) statements.push({ tokens: current, start, end: t.start });
      start = t.end;
      current = [];
    } else {
      current.push(t);
    }
  }
  if (current.length > 0) statements.push({ tokens: current, start, end: sql.length });
  return statements;
}

/** Split `tokens` on commas at parenthesis depth 0. */
function splitTopLevel(tokens: readonly SqlToken[]): readonly (readonly SqlToken[])[] {
  const parts: SqlToken[][] = [];
  let current: SqlToken[] = [];
  let depth = 0;
  for (const t of tokens) {
    if (isSymbol(t, '(') || isSymbol(t, '[')) depth++;
    if (isSymbol(t, ')') || isSymbol(t, ']')) depth--;
    if (depth === 0 && isSymbol(t, ',')) {
      parts.push(current);
      current = [];
    } else {
      current.push(t);
    }
  }
  parts.push(current);
  return parts.filter((part) => part.length > 0);
}

/** One identifier part: adjacent word / quoted / interpolation tokens (`tenant_${id}`). */
function readNamePart(
  tokens: readonly SqlToken[],
  index: number,
): { readonly text: string; readonly interpolated: boolean; readonly next: number } | null {
  let next = index;
  let text = '';
  let interpolated = false;
  while (next < tokens.length) {
    const t = tokens[next];
    if (t === undefined) break;
    const adjacent = next === index || tokens[next - 1]?.end === t.start;
    if (!adjacent) break;
    if (t.kind !== 'word' && t.kind !== 'quoted-identifier' && t.kind !== 'interpolation') break;
    text += t.value;
    interpolated ||= t.kind === 'interpolation' || t.interpolated;
    next++;
  }
  return next === index ? null : { text, interpolated, next };
}

export function readTableName(
  tokens: readonly SqlToken[],
  index: number,
): { readonly name: TableName; readonly next: number } | null {
  const parts: string[] = [];
  let interpolated = false;
  let next = index;
  for (;;) {
    const part = readNamePart(tokens, next);
    if (part === null) break;
    parts.push(part.text);
    interpolated ||= part.interpolated;
    next = part.next;
    if (!isSymbol(tokens[next], '.')) break;
    next++;
  }
  if (parts.length === 0) return null;
  const name: TableName = {
    key: parts.join('.'),
    baseName: parts[parts.length - 1] ?? '',
    qualified: parts.length > 1,
    interpolated,
  };
  return { name, next: isSymbol(tokens[next], '*') ? next + 1 : next };
}

/** Whether `name` is one of `created` (same key, or same base name when one side is unqualified). */
export function isCreatedTable(created: readonly TableName[], name: TableName): boolean {
  return created.some(
    (table) =>
      table.key === name.key ||
      (table.baseName === name.baseName && (!table.qualified || !name.qualified)),
  );
}

/** `GLOBAL`, `LOCAL`, `TEMP`/its long form, `UNLOGGED` between CREATE and TABLE (spelt as R6 spells it). */
function isTableModifier(t: SqlToken | undefined): boolean {
  return (
    t !== undefined &&
    t.kind === 'word' &&
    /^(?:global|local|temp(?:orary)?|unlogged)$/.test(t.value)
  );
}

/** Tables created by `CREATE [TEMP|UNLOGGED] TABLE [IF NOT EXISTS] <name>` in the statements. */
export function createdTables(statements: readonly SqlStatement[]): readonly TableName[] {
  const created: TableName[] = [];
  for (const { tokens } of statements) {
    for (let i = 0; i < tokens.length; i++) {
      if (!isWord(tokens[i], 'create')) continue;
      let j = i + 1;
      while (isTableModifier(tokens[j])) j++;
      if (!isWord(tokens[j], 'table')) continue;
      j++;
      if (
        isWord(tokens[j], 'if') &&
        isWord(tokens[j + 1], 'not') &&
        isWord(tokens[j + 2], 'exists')
      ) {
        j += 3;
      }
      const table = readTableName(tokens, j);
      if (table !== null) created.push(table.name);
    }
  }
  return created;
}

/** The column definition after the column name of an ADD COLUMN clause. */
function readColumnDefinition(
  rest: readonly SqlToken[],
): Pick<AddColumnAction, 'notNull' | 'defaultTokens' | 'generatedOrSerial' | 'inlineConstraint'> {
  let notNull = false;
  let defaultTokens: SqlToken[] | null = null;
  let generatedOrSerial = isWord(rest[0], ...SERIAL_TYPES);
  let inlineConstraint = false;
  let depth = 0;
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (isSymbol(t, '(') || isSymbol(t, '[')) depth++;
    if (isSymbol(t, ')') || isSymbol(t, ']')) depth--;
    if (depth !== 0 || t === undefined) continue;
    if (isWord(t, 'not') && isWord(rest[i + 1], 'null')) {
      notNull = true;
      i++;
    } else if (isWord(t, 'generated')) {
      generatedOrSerial = true;
    } else if (isWord(t, ...INLINE_CONSTRAINTS)) {
      inlineConstraint = true;
    } else if (isWord(t, 'default')) {
      const expression: SqlToken[] = [];
      let exprDepth = 0;
      let j = i + 1;
      for (; j < rest.length; j++) {
        const e = rest[j];
        if (e === undefined) break;
        if (exprDepth === 0) {
          const endsNotNull = isWord(e, 'not') && isWord(rest[j + 1], 'null');
          const endsNull = isWord(e, 'null') && expression.length > 0;
          if (endsNotNull || endsNull || isWord(e, ...DEFAULT_TERMINATORS)) break;
        }
        if (isSymbol(e, '(') || isSymbol(e, '[')) exprDepth++;
        if (isSymbol(e, ')') || isSymbol(e, ']')) exprDepth--;
        expression.push(e);
      }
      defaultTokens = expression;
      i = j - 1;
    }
  }
  return { notNull, defaultTokens, generatedOrSerial, inlineConstraint };
}

function classifyAction(tokens: readonly SqlToken[]): AlterAction {
  const start = tokens[0]?.start ?? 0;
  const end = tokens[tokens.length - 1]?.end ?? start;
  if (isWord(tokens[0], 'add') && !isWord(tokens[1], ...ADD_CONSTRAINT_STARTS)) {
    // `COLUMN` is optional in PostgreSQL's grammar: `ADD x int` adds a column.
    let k = isWord(tokens[1], 'column') ? 2 : 1;
    if (
      isWord(tokens[k], 'if') &&
      isWord(tokens[k + 1], 'not') &&
      isWord(tokens[k + 2], 'exists')
    ) {
      k += 3;
    }
    const column = readNamePart(tokens, k);
    if (column !== null) {
      return {
        kind: 'add-column',
        start,
        end,
        column: column.text,
        columnInterpolated: column.interpolated,
        ...readColumnDefinition(tokens.slice(column.next)),
        tokens,
      };
    }
  }
  if (isWord(tokens[0], 'drop') && !isWord(tokens[1], 'constraint')) {
    let k = isWord(tokens[1], 'column') ? 2 : 1;
    const ifExists = isWord(tokens[k], 'if') && isWord(tokens[k + 1], 'exists');
    if (ifExists) k += 2;
    const column = readNamePart(tokens, k);
    if (column !== null && !column.interpolated) {
      return { kind: 'drop-column', start, end, column: column.text, ifExists, tokens };
    }
  }
  return { kind: 'other', start, end, tokens };
}

/** Every `ALTER TABLE` in a statement, with its target and its comma-separated actions. */
export function alterTablesIn(statement: SqlStatement): readonly AlterTable[] {
  const { tokens } = statement;
  const alters: AlterTable[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!isWord(tokens[i], 'alter') || !isWord(tokens[i + 1], 'table')) continue;
    let j = i + 2;
    if (isWord(tokens[j], 'if') && isWord(tokens[j + 1], 'exists')) j += 2;
    if (isWord(tokens[j], 'only')) j++;
    const table = readTableName(tokens, j);
    const actionsFrom = table === null ? j : table.next;
    let actionsTo = actionsFrom;
    while (
      actionsTo < tokens.length &&
      !(isWord(tokens[actionsTo], 'alter') && isWord(tokens[actionsTo + 1], 'table'))
    ) {
      actionsTo++;
    }
    alters.push({
      start: tokens[i]?.start ?? 0,
      target: table === null ? null : table.name,
      actions: splitTopLevel(tokens.slice(actionsFrom, actionsTo)).map(classifyAction),
    });
    i = actionsTo - 1;
  }
  return alters;
}

function stripWrappingParens(tokens: readonly SqlToken[]): readonly SqlToken[] {
  let inner = tokens;
  while (isSymbol(inner[0], '(') && isSymbol(inner[inner.length - 1], ')')) {
    let depth = 0;
    let wrapsAll = true;
    for (let i = 0; i < inner.length - 1; i++) {
      if (isSymbol(inner[i], '(')) depth++;
      if (isSymbol(inner[i], ')')) depth--;
      if (depth === 0) wrapsAll = false;
    }
    if (!wrapsAll) break;
    inner = inner.slice(1, -1);
  }
  return inner;
}

/** The index after a cast's type name (`text`, `character varying(20)`, `"s"."e"[]`), or -1. */
function readCastType(tokens: readonly SqlToken[], index: number): number {
  let i = index;
  const first = tokens[i];
  if (first === undefined || (first.kind !== 'word' && first.kind !== 'quoted-identifier'))
    return -1;
  while (i < tokens.length && !isSymbol(tokens[i], '::')) {
    const t = tokens[i];
    if (t === undefined) break;
    if (t.kind === 'word' || t.kind === 'quoted-identifier' || isSymbol(t, '.')) {
      i++;
    } else if (isSymbol(t, '(') || isSymbol(t, '[')) {
      const close = isSymbol(t, '(') ? ')' : ']';
      i++;
      while (tokens[i]?.kind === 'number' || isSymbol(tokens[i], ',')) i++;
      if (!isSymbol(tokens[i], close)) return -1;
      i++;
    } else {
      return -1;
    }
  }
  return i;
}

/**
 * ADR-053 Decision 1: a literal (optionally cast, `'farm'::farm_registry_module_enum`,
 * `0`, `-1`, `false`, `NULL`, `'{}'::jsonb`) or `now()`, `CURRENT_TIMESTAMP`,
 * `CURRENT_DATE`. Volatility is a catalog property the gate cannot read, so the
 * list is closed: anything else, and any `${…}` interpolation, is outside it.
 */
export function isAllowlistedConstantDefault(expression: readonly SqlToken[]): boolean {
  const tokens = stripWrappingParens(expression);
  if (tokens.some((t) => t.kind === 'interpolation' || t.interpolated)) return false;
  if (tokens.length === 1 && isWord(tokens[0], 'current_timestamp', 'current_date')) return true;
  if (
    tokens.length === 3 &&
    isWord(tokens[0], 'now') &&
    isSymbol(tokens[1], '(') &&
    isSymbol(tokens[2], ')')
  ) {
    return true;
  }
  const signed = isSymbol(tokens[0], '-') || isSymbol(tokens[0], '+');
  const literal = tokens[signed ? 1 : 0];
  const isLiteral = signed
    ? literal?.kind === 'number'
    : literal?.kind === 'string' ||
      literal?.kind === 'number' ||
      isWord(literal, 'true', 'false', 'null');
  if (!isLiteral) return false;
  let i = signed ? 2 : 1;
  while (i < tokens.length) {
    if (!isSymbol(tokens[i], '::')) return false;
    i = readCastType(tokens, i + 1);
    if (i === -1) return false;
  }
  return true;
}
