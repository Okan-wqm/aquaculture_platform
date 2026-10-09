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
 * positive on exactly that shape. Comments are stripped and only the
 * up() body is scanned.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

/**
 * Reviewer-gated allowlist: shipped migrations that inline the pair.
 * The first cut matched only `ADD COLUMN` with bare index names under
 * `src/database/migrations`, so it saw 4 of the 33 shipped pairs; the
 * detector now reads the repo's quoted names, TypeORM's `ADD "col"`,
 * UNIQUE/CONCURRENTLY indexes and both migration layouts, and the
 * pairs it surfaced are listed here — never fixed by editing a shipped
 * migration.
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
  'apps/notification-service/src/database/migrations/1801100000000-CreateNotificationInAppDeliveryReceipt.ts',
  'apps/sensor-service/src/database/migrations/1801100000000-UnifiedTagLifecycle.ts',
  'apps/sensor-service/src/database/migrations/1801200000000-ProgramVariableTenantId.ts',
  'apps/sensor-service/src/database/migrations/1801400000000-DeployLogArtifactColumns.ts',
  'apps/sensor-service/src/database/migrations/1806300000000-ScadaTenantIsolation.ts',
]);

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function upBody(source: string): string {
  const match = source.match(/async up\([^)]*\)[^{]*\{([\s\S]*?)(?:async down\(|$)/);
  return match?.[1] ?? '';
}

/**
 * One table reference as written in migration SQL: quoted or bare, optionally
 * schema-qualified, or a `${...}` template placeholder. The LAST segment is
 * the table; a placeholder is kept verbatim so two references to the same
 * constant still pair up.
 */
const TABLE_REF = String.raw`((?:"[^"]+"|\$\{[^}]+\}|\w+)(?:\s*\.\s*(?:"[^"]+"|\$\{[^}]+\}|\w+))*)`;

function tableName(ref: string): string {
  const segments = ref.split(/\s*\.\s*(?=(?:"|\$\{|\w))/);
  return (segments[segments.length - 1] ?? ref).replace(/^"|"$/g, '');
}

/** `"col"` or `col` → `col`; every identifier in an index column list. */
function identifiers(text: string): string[] {
  return [...text.matchAll(/"([^"]+)"|\b([A-Za-z_]\w*)\b/g)]
    .map((m) => m[1] ?? m[2] ?? '')
    .filter(
      (name) => name && !/^(ASC|DESC|NULLS|FIRST|LAST|COLLATE|lower|upper|coalesce)$/i.test(name),
    );
}

/**
 * Columns a migration ADDS, per table: every `ADD [COLUMN] [IF NOT EXISTS]
 * <col>` clause of an `ALTER TABLE [IF EXISTS] [ONLY] <t> ...` statement (the
 * TypeORM generator writes `ADD "col"` without COLUMN, and one ALTER may add
 * several), and `queryRunner.addColumn('<t>', new TableColumn({ name }))`.
 * `ADD CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|CHECK|EXCLUDE` adds no column.
 */
function addedColumns(body: string): Map<string, Set<string>> {
  const added = new Map<string, Set<string>>();
  const note = (table: string, column: string): void => {
    const set = added.get(table) ?? new Set<string>();
    set.add(column);
    added.set(table, set);
  };
  const alter = new RegExp(
    String.raw`ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${TABLE_REF}([\s\S]*?)(?=ALTER\s+TABLE|CREATE\s|DROP\s|;|\x60|$)`,
    'gi',
  );
  let m: RegExpExecArray | null;
  while ((m = alter.exec(body)) !== null) {
    const table = tableName(m[1] ?? '');
    const clauses =
      /\bADD\s+(?!CONSTRAINT\b|PRIMARY\b|FOREIGN\b|UNIQUE\b|CHECK\b|EXCLUDE\b)(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?:"([^"]+)"|(\w+))/gi;
    let c: RegExpExecArray | null;
    while ((c = clauses.exec(m[2] ?? '')) !== null) note(table, c[1] ?? c[2] ?? '');
  }
  const api = /\.addColumn\(\s*['"`]([\w.]+)['"`][\s\S]*?name:\s*['"`](\w+)['"`]/g;
  while ((m = api.exec(body)) !== null) note(tableName(m[1] ?? ''), m[2] ?? '');
  return added;
}

/**
 * Columns each index covers, per table: `CREATE [UNIQUE] INDEX [CONCURRENTLY]
 * [IF NOT EXISTS] [<name>] ON [ONLY] <t> [USING <m>] (<columns>)` — quoted
 * names are the repo convention — and `queryRunner.createIndex('<t>', new
 * TableIndex({ columnNames: [...] }))`.
 */
function indexedColumns(body: string): Map<string, Set<string>> {
  const indexed = new Map<string, Set<string>>();
  const note = (table: string, columns: string[]): void => {
    const set = indexed.get(table) ?? new Set<string>();
    columns.forEach((column) => set.add(column));
    indexed.set(table, set);
  };
  const sql = new RegExp(
    String.raw`CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?:(?:"[^"]+"|\$\{[^}]+\}|\w+)\s+)?ON\s+(?:ONLY\s+)?${TABLE_REF}\s*(?:USING\s+\w+\s*)?\(([^;\x60]*?)\)\s*(?:WHERE|INCLUDE|;|\x60|$|\))`,
    'gi',
  );
  let m: RegExpExecArray | null;
  while ((m = sql.exec(body)) !== null) note(tableName(m[1] ?? ''), identifiers(m[2] ?? ''));
  const api = /\.createIndex\(\s*['"`]([\w.]+)['"`][\s\S]*?columnNames:\s*\[([^\]]*)\]/g;
  while ((m = api.exec(body)) !== null) note(tableName(m[1] ?? ''), identifiers(m[2] ?? ''));
  return indexed;
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

/** `table.column` pairs a migration's up() body both ADDS and INDEXES. */
function inlinedPairs(source: string): string[] {
  const body = upBody(stripComments(source));
  const indexed = indexedColumns(body);
  const pairs: string[] = [];
  for (const [table, columns] of addedColumns(body)) {
    for (const column of columns) {
      if (indexed.get(table)?.has(column)) pairs.push(`${table}.${column}`);
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
