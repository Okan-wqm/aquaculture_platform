/**
 * DEBT-2026-05-07-001 — the add-column-then-index pair must go through
 * the shared helper.
 *
 * The debt record's root cause: the TypeORM migration generator copies
 * the idempotent ADD COLUMN + CREATE INDEX boilerplate verbatim into
 * each new migration file, so the pattern multiplied across services
 * and silently absorbed maintenance cost. With
 * `addColumnWithIndex` landed in migration-helpers.ts, this invariant
 * bans FUTURE inlined pairs; shipped migrations are immutable
 * (migration-immutability-witness.ts) and are grandfathered in an
 * in-spec allowlist with a stale-exemption test — the ddl-guard idiom
 * (tenant-aware-migration-ddl-guard.spec.ts), never a self-service
 * marker.
 *
 * Detection is per TABLE, not per file: a migration legitimately adds
 * a column WITHOUT an index to table A while creating an index on an
 * EXISTING column of table B — file-level co-occurrence would false-
 * positive on exactly that shape. Only the code up() runs is read
 * (upReachableEvidence below); comments are not code and drop out with the
 * parse.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import ts from 'typescript';

const REPO_ROOT = resolve(__dirname, '..', '..');

/**
 * Reviewer-gated allowlist: shipped migrations that inline the pair.
 * The first cut matched only `ADD COLUMN` with bare index names under
 * `src/database/migrations`, so it saw 4 of the 33 shipped pairs; the
 * detector now reads the repo's quoted names, TypeORM's `ADD "col"`,
 * UNIQUE/CONCURRENTLY indexes and both migration layouts, and the
 * pairs it surfaced are listed here — never fixed by editing a shipped
 * migration. The AST reader of ARIA-LOW-405 surfaced three more, each
 * with its CREATE INDEX split across a `+` concatenation the regex could not
 * cross: the farm PII migration's `emailHash` and the two messaging
 * `embedding` migrations.
 * A file may leave this set only by becoming a new migration that uses
 * the helper (impossible — migrations are immutable) or by deletion;
 * the stale-exemption test fails when an entry stops violating, so the
 * set cannot silently rot.
 */
const GRANDFATHERED: ReadonlySet<string> = new Set([
  'apps/admin-api-service/src/migrations/1800300000000-AdminAnalyticsSnapshotsAndReportArtifacts.ts',
  'apps/admin-api-service/src/migrations/1800400000000-TenantProvisioningWorkflow.ts',
  'apps/admin-api-service/src/migrations/1800750000000-RetirePlaintextSchemaBackups.ts',
  'apps/admin-api-service/src/migrations/1801200000000-TenantProvisioningWorkflowLeaseAndOnboardingAcks.ts',
  'apps/admin-api-service/src/migrations/1808900000000-ProtectAdminLedgers.ts',
  'apps/admin-api-service/src/migrations/1809600000000-ProjectionSourceEventIdentity.ts',
  'apps/alert-engine/src/database/migrations/1801100000000-AddAlertHistorySourceEventId.ts',
  'apps/auth-service/src/migrations/1800500000000-AddRefreshTokenFamilyId.ts',
  'apps/billing-service/src/database/migrations/1802500000000-MergePlanCatalogue.ts',
  'apps/event-store-service/src/migrations/1800100000000-EventLedgerHardening.ts',
  'apps/farm-service/src/database/migrations/1800200000000-CreateFarmOutboxTable.ts',
  'apps/farm-service/src/database/migrations/1800300000000-AlignEquipmentTypesRuntimeContract.ts',
  'apps/farm-service/src/database/migrations/1800900000000-AddTankSetupMetadata.ts',
  'apps/farm-service/src/database/migrations/1801100000000-EncryptFarmWorkerPii.ts',
  'apps/farm-service/src/database/migrations/1801400000000-AddSiteContractFields.ts',
  'apps/farm-service/src/database/migrations/1802000000000-AddBatchProtocolId.ts',
  'apps/farm-service/src/database/migrations/1802100000000-AddEquipmentTemperatureSensorId.ts',
  'apps/farm-service/src/database/migrations/1802300000000-AddTankTemperatureSensorId.ts',
  'apps/farm-service/src/database/migrations/1802600000000-AddSiteRegulatoryIdentity.ts',
  'apps/farm-service/src/database/migrations/1803200000000-AddTankRegulatoryUnitId.ts',
  'apps/farm-service/src/database/migrations/1803400000000-AddWorkerVeterinaryFields.ts',
  'apps/farm-service/src/database/migrations/1803700000000-AddRegulatoryReportRetryColumns.ts',
  'apps/farm-service/src/database/migrations/1806400000000-CreateFeedingDayPlanAndMeals.ts',
  'apps/farm-service/src/database/migrations/1807100000000-CreateEnvironmentalObservationFoundation.ts',
  'apps/farm-service/src/database/migrations/1810300000000-LinkTankOperationToHarvestRecord.ts',
  'apps/farm-service/src/database/migrations/1822000000000-ExtendParamEquipmentToChannelSources.ts',
  'apps/hr-service/src/database/migrations/1801600000000-AddEmployeeLaborCategory.ts',
  'apps/messaging-service/src/migrations/1800200000000-CreateMessagingOutboxTable.ts',
  'apps/messaging-service/src/migrations/1800400000000-EnforceSourceOnlyMessagingOutboxContract.ts',
  'apps/messaging-service/src/migrations/1800700000000-AddMessagesEmbeddingColumn.ts',
  'apps/messaging-service/src/migrations/1802200000000-EnsureTenantMessagesEmbeddingColumn.ts',
  'apps/notification-service/src/database/migrations/1801100000000-CreateNotificationInAppDeliveryReceipt.ts',
  'apps/sensor-service/src/database/migrations/1801100000000-UnifiedTagLifecycle.ts',
  'apps/sensor-service/src/database/migrations/1801200000000-ProgramVariableTenantId.ts',
  'apps/sensor-service/src/database/migrations/1801400000000-DeployLogArtifactColumns.ts',
  'apps/sensor-service/src/database/migrations/1806300000000-ScadaTenantIsolation.ts',
]);

/**
 * ARIA-LOW-405: the first detectors read the raw text between `async up(` and
 * `async down(` with regexes, which missed DDL in a method declared after
 * down() and called from up(), the plural `addColumns` / `createIndices` API,
 * a non-literal table argument, `ALTER t DROP COLUMN a, ADD COLUMN b` (the
 * clause scan stopped at DROP) and an unquoted `${col}` after IF NOT EXISTS
 * (captured as the column `IF`). The detector now parses the migration with
 * the TypeScript compiler and reads only the code up() runs:
 *
 *   - up()'s body, every member of the same class it reaches through `this.x`
 *     (methods and property initialisers, wherever they are declared), every
 *     top-level function it calls and the initialiser of every top-level
 *     variable it reads, transitively; down() is never entered;
 *   - each string the reached code builds (literal, template, `+` chain),
 *     with `${x}` replaced by the value of a top-level string constant `x`
 *     and kept verbatim otherwise, so a placeholder pairs with itself;
 *   - each SQL statement of those strings, ALTER TABLE actions split at
 *     top-level commas;
 *   - TypeORM's addColumn / addColumns / createIndex / createIndices, whose
 *     table argument is resolved like a placeholder.
 *
 * Out of reach: DDL in a function imported from another file (which is why
 * a migration that calls the shared helper passes) and SQL assembled at run
 * time from values the file does not hold.
 */

/** A table or column as a pairing key: the last name segment, unquoted. */
function nameKey(reference: string): string {
  const segments = splitTopLevel(reference.trim(), '.');
  return (segments[segments.length - 1] ?? reference).trim().replace(/^"|"$/g, '');
}

/** SQL identifier as written: quoted, a `${...}` placeholder, or bare. */
const IDENT = String.raw`(?:"[^"]+"|\$\{[^}]+\}|[A-Za-z_]\w*)`;
const TABLE_REF = String.raw`(${IDENT}(?:\s*\.\s*${IDENT})*)`;

/** Index-list words that are not columns. */
const NOT_A_COLUMN = /^(ASC|DESC|NULLS|FIRST|LAST|COLLATE|lower|upper|coalesce)$/i;

/** Every column named in an index column list: quoted, bare or a placeholder. */
function indexListColumns(text: string): string[] {
  return [...text.matchAll(/"([^"]+)"|(\$\{[^}]+\})|\b([A-Za-z_]\w*)\b/g)]
    .map((m) => m[1] ?? m[2] ?? m[3] ?? '')
    .filter((name) => name !== '' && !NOT_A_COLUMN.test(name));
}

/** Split at a separator outside quotes, `${...}` placeholders and parentheses. */
function splitTopLevel(text: string, separator: ';' | ',' | '.'): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let current = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '$' && text.charAt(i + 1) === '{') {
      const close = text.indexOf('}', i);
      if (close !== -1) {
        current += text.slice(i, close + 1);
        i = close;
        continue;
      }
    } else if (ch === '(') {
      depth += 1;
    } else if (ch === ')') {
      depth -= 1;
    } else if (ch === separator && depth <= 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

/** The text inside the parentheses that open at `open`, balanced. */
function balancedGroup(text: string, open: number): string | null {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return null;
}

const ADD_COLUMN_ACTION = new RegExp(
  String.raw`^ADD\s+(?!(?:CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|CHECK|EXCLUDE)\b)(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?!IF\s+NOT\s+EXISTS\b)(${IDENT})`,
  'i',
);
const ALTER_TABLE = new RegExp(
  String.raw`\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${TABLE_REF}\s+`,
  'gi',
);
const CREATE_INDEX = new RegExp(
  String.raw`\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?:(?!ON\b)${IDENT}\s+)?ON\s+(?:ONLY\s+)?${TABLE_REF}\s*(?:USING\s+\w+\s*)?(?=\()`,
  'gi',
);

interface PairEvidence {
  readonly added: Map<string, Set<string>>;
  readonly indexed: Map<string, Set<string>>;
}

function note(map: Map<string, Set<string>>, table: string, columns: readonly string[]): void {
  const set = map.get(table) ?? new Set<string>();
  for (const column of columns) set.add(column);
  map.set(table, set);
}

/** ADD COLUMN and CREATE INDEX facts of one SQL string. */
function readSql(sql: string, evidence: PairEvidence): void {
  for (const statement of splitTopLevel(sql, ';')) {
    for (const alter of statement.matchAll(ALTER_TABLE)) {
      const table = nameKey(alter[1] ?? '');
      const actions = statement.slice((alter.index ?? 0) + alter[0].length);
      for (const action of splitTopLevel(actions, ',')) {
        const column = ADD_COLUMN_ACTION.exec(action.trim());
        if (column?.[1] !== undefined) note(evidence.added, table, [nameKey(column[1])]);
      }
    }
    for (const index of statement.matchAll(CREATE_INDEX)) {
      const columns = balancedGroup(statement, (index.index ?? 0) + index[0].length);
      if (columns !== null)
        note(evidence.indexed, nameKey(index[1] ?? ''), indexListColumns(columns));
    }
  }
}

/** The top-level declarations of a migration file, by name. */
interface FileScope {
  readonly functions: Map<string, ts.Node>;
  readonly variables: Map<string, ts.Expression>;
  readonly strings: Map<string, string>;
}

function fileScope(file: ts.SourceFile): FileScope {
  const functions = new Map<string, ts.Node>();
  const variables = new Map<string, ts.Expression>();
  const strings = new Map<string, string>();
  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
      functions.set(statement.name.text, statement.body);
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined) continue;
        variables.set(declaration.name.text, declaration.initializer);
        let value: ts.Expression = declaration.initializer;
        while (ts.isAsExpression(value) || ts.isParenthesizedExpression(value))
          value = value.expression;
        if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) {
          strings.set(declaration.name.text, value.text);
        }
      }
    }
  }
  return { functions, variables, strings };
}

/** A string-building expression rendered as text, `${x}` resolved through the file's constants. */
function renderString(node: ts.Expression, scope: FileScope, file: ts.SourceFile): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    let text = node.head.text;
    for (const span of node.templateSpans) {
      text += placeholder(span.expression, scope, file) + span.literal.text;
    }
    return text;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = renderString(node.left, scope, file);
    const right = renderString(node.right, scope, file);
    if (left === null && right === null) return null;
    return (
      (left ?? placeholder(node.left, scope, file)) +
      (right ?? placeholder(node.right, scope, file))
    );
  }
  if (ts.isParenthesizedExpression(node)) return renderString(node.expression, scope, file);
  return null;
}

function placeholder(expression: ts.Expression, scope: FileScope, file: ts.SourceFile): string {
  if (ts.isIdentifier(expression)) {
    const value = scope.strings.get(expression.text);
    if (value !== undefined) return value;
  }
  return `\${${expression.getText(file)}}`;
}

/** A TypeORM API argument as a pairing key: a literal, a file constant, or the expression verbatim. */
function argumentKey(node: ts.Expression, scope: FileScope, file: ts.SourceFile): string {
  return nameKey(renderString(node, scope, file) ?? placeholder(node, scope, file));
}

/** Values of `property: ...` assignments under `node` (TableColumn name, TableIndex columnNames). */
function propertyValues(
  node: ts.Node,
  property: string,
  scope: FileScope,
  file: ts.SourceFile,
): string[] {
  const values: string[] = [];
  const visit = (current: ts.Node): void => {
    if (
      ts.isPropertyAssignment(current) &&
      (ts.isIdentifier(current.name) || ts.isStringLiteral(current.name)) &&
      current.name.text === property
    ) {
      const value = current.initializer;
      const elements = ts.isArrayLiteralExpression(value) ? [...value.elements] : [value];
      for (const element of elements) values.push(argumentKey(element, scope, file));
      return;
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return values;
}

const ADD_COLUMN_APIS = new Set(['addColumn', 'addColumns']);
const CREATE_INDEX_APIS = new Set(['createIndex', 'createIndices']);

/** Facts of the code up() runs, per class with an up(). */
function upReachableEvidence(source: string): PairEvidence {
  const file = ts.createSourceFile('migration.ts', source, ts.ScriptTarget.Latest, true);
  const scope = fileScope(file);
  const evidence: PairEvidence = { added: new Map(), indexed: new Map() };

  for (const statement of file.statements) {
    if (!ts.isClassDeclaration(statement)) continue;
    const members = new Map<string, ts.Node>();
    for (const member of statement.members) {
      if (member.name === undefined || !ts.isIdentifier(member.name)) continue;
      if (ts.isMethodDeclaration(member) && member.body) members.set(member.name.text, member.body);
      if (ts.isPropertyDeclaration(member) && member.initializer) {
        members.set(member.name.text, member.initializer);
      }
    }
    const up = members.get('up');
    if (up === undefined) continue;

    const visited = new Set<ts.Node>();
    const pending: ts.Node[] = [up];
    const enqueue = (node: ts.Node | undefined): void => {
      if (node !== undefined && !visited.has(node)) pending.push(node);
    };
    while (pending.length > 0) {
      const root = pending.pop();
      if (root === undefined || visited.has(root)) continue;
      visited.add(root);
      const visit = (node: ts.Node): void => {
        if (ts.isExpression(node)) {
          const text = renderString(node, scope, file);
          if (text !== null) {
            readSql(text, evidence);
            return;
          }
        }
        if (
          ts.isPropertyAccessExpression(node) &&
          node.expression.kind === ts.SyntaxKind.ThisKeyword &&
          node.name.text !== 'down'
        ) {
          enqueue(members.get(node.name.text));
        }
        if (ts.isIdentifier(node) && !ts.isPropertyAccessExpression(node.parent)) {
          enqueue(scope.functions.get(node.text));
          enqueue(scope.variables.get(node.text));
        }
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.arguments.length >= 2
        ) {
          const api = node.expression.name.text;
          const [tableArgument, detail] = node.arguments;
          if (tableArgument !== undefined && detail !== undefined) {
            const table = argumentKey(tableArgument, scope, file);
            if (ADD_COLUMN_APIS.has(api)) {
              note(evidence.added, table, propertyValues(detail, 'name', scope, file));
            }
            if (CREATE_INDEX_APIS.has(api)) {
              note(evidence.indexed, table, propertyValues(detail, 'columnNames', scope, file));
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(root);
    }
  }
  return evidence;
}

/** Both migration layouts in the repo: `src/database/migrations` and `src/migrations`. */
const MIGRATION_DIRS = [
  ['src', 'database', 'migrations'],
  ['src', 'migrations'],
] as const;

function discoverMigrations(): string[] {
  const appsDir = resolve(REPO_ROOT, 'apps');
  const found: string[] = [];
  for (const service of readdirSync(appsDir)) {
    for (const segments of MIGRATION_DIRS) {
      const migrationsDir = resolve(appsDir, service, ...segments);
      if (!existsSync(migrationsDir)) continue;
      for (const entry of readdirSync(migrationsDir)) {
        if (/^[0-9].*-.*\.ts$/.test(entry)) {
          found.push(`apps/${service}/${segments.join('/')}/${entry}`);
        }
      }
    }
  }
  return found.filter((f) => !f.includes('/.archive/'));
}

/** `table.column` pairs the code a migration's up() runs both ADDS and INDEXES. */
function inlinedPairs(source: string): string[] {
  const { added, indexed } = upReachableEvidence(source);
  const pairs: string[] = [];
  for (const [table, columns] of added) {
    const indexedColumns = indexed.get(table);
    if (indexedColumns === undefined) continue;
    for (const column of columns) {
      if (indexedColumns.has(column)) pairs.push(`${table}.${column}`);
    }
  }
  return pairs;
}

describe('DEBT-2026-05-07-001 — add-column+index pairs use the shared helper', () => {
  const migrations = discoverMigrations();

  it('the migration corpus is discovered (a broken glob must not pass silently)', () => {
    // Floor, not a pin: 195 today across 10 services; a glob that
    // silently matches nothing must fail, exact drift is not asserted.
    expect(migrations.length).toBeGreaterThan(150);
  });

  it('detects every shape the repo writes the pair in', () => {
    // The shipped farm migration the first detector missed (quoted index
    // name, multi-line ALTER).
    const shipped = readFileSync(
      resolve(
        REPO_ROOT,
        'apps/farm-service/src/database/migrations/1802100000000-AddEquipmentTemperatureSensorId.ts',
      ),
      'utf8',
    );
    expect(inlinedPairs(shipped)).toEqual(['equipment.temperatureSensorId']);
    const up = (sql: string[]): string =>
      `export class M { async up(q) { ${sql.map((s) => `await q.query(\`${s}\`);`).join(' ')} } async down(q) {} }`;
    // TypeORM's generator: ADD "col" without COLUMN, UNIQUE index.
    expect(
      inlinedPairs(
        up([
          'ALTER TABLE "orders" ADD "ref" uuid',
          'CREATE UNIQUE INDEX "IDX_ref" ON "orders" ("ref")',
        ]),
      ),
    ).toEqual(['orders.ref']);
    // Schema-qualified, CONCURRENTLY, bare index name, several ADDs in one ALTER.
    expect(
      inlinedPairs(
        up([
          'ALTER TABLE "billing"."invoices" ADD COLUMN IF NOT EXISTS "a" text, ADD COLUMN "b" text',
          'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_b ON "billing"."invoices" USING btree ("b")',
        ]),
      ),
    ).toEqual(['invoices.b']);
    // A column added to one table and an index on an EXISTING column of
    // another (or of the same table) is not the pair; neither is a constraint.
    expect(
      inlinedPairs(
        up([
          'ALTER TABLE "a" ADD COLUMN "x" text',
          'CREATE INDEX "IDX_b_y" ON "b" ("y")',
          'CREATE INDEX "IDX_a_z" ON "a" ("z")',
          'ALTER TABLE "c" ADD CONSTRAINT "UQ_c" UNIQUE ("w")',
          'CREATE INDEX "IDX_c_w" ON "c" ("w")',
        ]),
      ),
    ).toEqual([]);
    // The TypeORM queryRunner API form.
    expect(
      inlinedPairs(
        `export class M { async up(q) { await q.addColumn('tanks', new TableColumn({ name: 'k', type: 'uuid' })); ` +
          `await q.createIndex('tanks', new TableIndex({ columnNames: ['k'] })); } async down(q) {} }`,
      ),
    ).toEqual(['tanks.k']);
  });

  it('ARIA-LOW-405: reads an ADD after a DROP in one ALTER', () => {
    // The clause scan stopped at DROP.
    expect(
      inlinedPairs(
        'export class M { async up(q) { ' +
          'await q.query(`ALTER TABLE "t" DROP COLUMN "a", ADD COLUMN "b" text`); ' +
          'await q.query(`CREATE INDEX "IDX_t_b" ON "t" ("b")`); } async down(q) {} }',
      ),
    ).toEqual(['t.b']);
  });

  it('ARIA-LOW-405: reads an unquoted placeholder after IF NOT EXISTS', () => {
    // It was captured as the column IF. A placeholder pairs with itself, and a
    // file constant resolves to its value.
    expect(
      inlinedPairs(
        'export class M { async up(q) { const col = pick(); ' +
          'await q.query(`ALTER TABLE "t" ADD COLUMN IF NOT EXISTS ${col} text`); ' +
          'await q.query(`CREATE INDEX IF NOT EXISTS "IDX_t" ON "t" (${col})`); } async down(q) {} }',
      ),
    ).toEqual(['t.${col}']);
    expect(
      inlinedPairs(
        'const COLUMN = \'"ref"\'; export class M { async up(q) { ' +
          'await q.query(`ALTER TABLE "t" ADD COLUMN IF NOT EXISTS ${COLUMN} uuid`); ' +
          'await q.query(`CREATE INDEX "IDX_t_ref" ON "t" ("ref")`); } async down(q) {} }',
      ),
    ).toEqual(['t.ref']);
  });

  it('ARIA-LOW-405: reads DDL in methods and functions up() calls, never down()', () => {
    // A private method declared after down() and a top-level function.
    expect(
      inlinedPairs(
        'export class M { async up(q) { await this.addRef(q); } ' +
          'async down(q) { await q.query(`ALTER TABLE "d" ADD COLUMN "x" text`); ' +
          'await q.query(`CREATE INDEX "IDX_d_x" ON "d" ("x")`); } ' +
          'private async addRef(q) { await q.query(`ALTER TABLE "t" ADD "ref" uuid`); await indexRef(q); } } ' +
          'async function indexRef(q) { await q.query(`CREATE INDEX "IDX_t_ref" ON "t" ("ref")`); }',
      ),
    ).toEqual(['t.ref']);
  });

  it('ARIA-LOW-405: reads the plural TypeORM API', () => {
    expect(
      inlinedPairs(
        'export class M { async up(q) { ' +
          "await q.addColumns('tanks', [new TableColumn({ name: 'j', type: 'text' }), new TableColumn({ name: 'k', type: 'uuid' })]); " +
          "await q.createIndices('tanks', [new TableIndex({ columnNames: ['k'] })]); } async down(q) {} }",
      ),
    ).toEqual(['tanks.k']);
  });

  it('ARIA-LOW-405: reads a non-literal table argument', () => {
    // A file constant resolves; any other expression pairs with the same
    // expression in SQL.
    expect(
      inlinedPairs(
        "const TABLE = 'farm.tanks'; export class M { async up(q) { " +
          "await q.addColumn(TABLE, new TableColumn({ name: 'k', type: 'uuid' })); " +
          'await q.query(`CREATE INDEX "IDX_tanks_k" ON "farm"."tanks" ("k")`); } async down(q) {} }',
      ),
    ).toEqual(['tanks.k']);
    expect(
      inlinedPairs(
        'export class M { table = tableFor(); async up(q) { ' +
          "await q.addColumn(this.table, new TableColumn({ name: 'k', type: 'uuid' })); " +
          'await q.query(`CREATE INDEX "IDX_k" ON ${this.table} ("k")`); } async down(q) {} }',
      ),
    ).toEqual(['${this.table}.k']);
  });

  it('scans both migration layouts', () => {
    expect(migrations.some((m) => m.includes('/src/migrations/'))).toBe(true);
    expect(migrations.some((m) => m.includes('/src/database/migrations/'))).toBe(true);
  });

  it('no NEW migration inlines the same-table add-column+index pair', () => {
    const violations: string[] = [];
    for (const relPath of migrations) {
      if (GRANDFATHERED.has(relPath)) continue;
      // No text marker exempts a file: a migration that calls the helper
      // carries no inlined pair, so it passes on what it does, not on a word.
      const overlap = inlinedPairs(readFileSync(resolve(REPO_ROOT, relPath), 'utf8'));
      if (overlap.length > 0) {
        violations.push(`${relPath} (${overlap.join(', ')})`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('every grandfathered entry still exists and still inlines the pair (no stale exemptions)', () => {
    for (const relPath of GRANDFATHERED) {
      const abs = resolve(REPO_ROOT, relPath);
      expect(existsSync(abs)).toBe(true);
      expect(inlinedPairs(readFileSync(abs, 'utf8')).length).toBeGreaterThan(0);
    }
  });
});
