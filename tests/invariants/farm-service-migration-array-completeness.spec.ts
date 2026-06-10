/**
 * farm-service migration array completeness invariant — FARM-LOW-001 follow-up
 * ============================================================================
 *
 * Farm-service has TWO migration discovery paths:
 *
 *   a. The aqua-db-migrate orchestrator's numeric migration glob
 *      'apps/farm-service/src/database/migrations/[0-9]*{.ts,.js}'
 *      used by production deploys.
 *
 *   b. The explicit `migrations: [...]` array in
 *      'apps/farm-service/src/app.module.ts' consulted by farm-service's
 *      in-process MigrationRunnerService when DATABASE_MIGRATIONS_RUN=true
 *      (dev / E2E paths).
 *
 * The two paths drift the moment a developer adds a migration file
 * without remembering to import it into the explicit array. Production
 * keeps applying the new migration via glob; dev / E2E silently skip
 * it and run against pre-N schema state.
 *
 * FARM-LOW-001 (PR-53) closed the existing drift — 8 migrations
 * between 1786000000000 and 1788100000000 were on disk but missing
 * from the array. This invariant freezes the parity going forward:
 * any new on-disk migration without a matching `import { ... } from
 * '...'` line in app.module.ts AND a matching entry in the
 * `migrations: [...]` literal fails CI before merge.
 *
 * # When this spec fails
 *
 *   - On-disk file 'NNNN-Name.ts' exists, app.module.ts does NOT
 *     import it → add the import + array entry.
 *   - app.module.ts imports a migration class that is not on disk →
 *     remove the dead import or restore the file.
 *   - app.module.ts imports a migration class but does NOT include
 *     it in the `migrations: [...]` array literal → add the array
 *     entry.
 *
 * # What this invariant does NOT check
 *
 *   - Whether the imported class actually implements
 *     MigrationInterface — that's tsc's job.
 *   - The order of entries in the array. The runner orders by the
 *     timestamp embedded in the class name, not by array position;
 *     timestamp-ascending is a code-style preference enforced by
 *     review, not by this invariant.
 *   - Whether the in-process registration matches the orchestrator's
 *     glob discovery — both are read from the same file system, so
 *     parity with the orchestrator is implicit if parity with disk
 *     is enforced (this invariant's contract).
 *   - Other services. Each tenant-aware service owns its own
 *     migrations array; this invariant is scoped to farm-service
 *     because that is where FARM-LOW-001 surfaced. A platform-wide
 *     generalisation could come later if other services exhibit
 *     the same drift class.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MIGRATIONS_DIR = path.resolve(REPO_ROOT, 'apps/farm-service/src/database/migrations');
const APP_MODULE_PATH = path.resolve(REPO_ROOT, 'apps/farm-service/src/app.module.ts');
const DATA_SOURCE_PATH = path.resolve(REPO_ROOT, 'apps/farm-service/src/database/data-source.ts');
const MANIFEST_PATH = path.resolve(
  REPO_ROOT,
  'apps/farm-service/src/database/migrations/manifest.ts',
);
const DB_MIGRATE_SCHEMA_REGISTRY_PATH = path.resolve(
  REPO_ROOT,
  'apps/db-migrate/src/schema-registry.ts',
);
const FARM_SEED_PATH = path.resolve(
  REPO_ROOT,
  'apps/farm-service/src/database/services/farm-seed.service.ts',
);
const EQUIPMENT_TYPE_ENTITY_PATH = path.resolve(
  REPO_ROOT,
  'apps/farm-service/src/equipment/entities/equipment-type.entity.ts',
);
const TENANT_SCHEMA_HARNESS_PATH = path.resolve(
  REPO_ROOT,
  'apps/farm-service/src/__tests__/e2e/helpers/tenant-schema-harness.ts',
);
const FARM_BASELINE_PATH = path.resolve(
  REPO_ROOT,
  'apps/farm-service/src/database/migrations/1800000000000-Baseline.ts',
);
const FARM_EQUIPMENT_TYPES_REPAIR_PATH = path.resolve(
  REPO_ROOT,
  'apps/farm-service/src/database/migrations/1800300000000-AlignEquipmentTypesRuntimeContract.ts',
);

/**
 * Class name pattern: `<Name><13-digit-timestamp>`. Every migration
 * file in the canonical farm-service layout exports a class whose
 * name starts with a capital letter, contains arbitrary CamelCase,
 * and ends in a 13-digit timestamp. The same identifier appears in
 * app.module.ts twice — once in the import, once in the array.
 */
const MIGRATION_CLASS_REGEX = /^([A-Z][A-Za-z0-9]*\d{13})$/;

/**
 * Discover every '.ts' file in the migrations directory whose
 * filename matches the canonical 'NNNN-Name.ts' pattern. Returns
 * the canonical class name for each (parsed from the file's
 * `export class` declaration) so the comparison is identifier-based
 * rather than filename-based.
 */
function listOnDiskMigrationClasses(): string[] {
  const entries = readdirSync(MIGRATIONS_DIR, { withFileTypes: true });
  const classNames: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.ts')) continue;
    // Exclude `.spec.ts` (test files for migrations) and `.d.ts`
    // (type declarations) — both can legitimately live alongside a
    // migration but are not migrations themselves.
    if (entry.name.endsWith('.spec.ts')) continue;
    if (entry.name.endsWith('.d.ts')) continue;
    if (!/^\d{13}-/.test(entry.name)) continue;
    const source = readFileSync(path.join(MIGRATIONS_DIR, entry.name), 'utf8');
    const match = source.match(/export\s+class\s+([A-Z][A-Za-z0-9]*\d{13})\b/);
    if (!match || !match[1]) {
      throw new Error(
        `Migration file ${entry.name} does not export a class matching ` +
          'the canonical `<Name><13-digit-timestamp>` pattern. Either ' +
          "rename the class to match the file's timestamp or move the " +
          'file out of the migrations directory.',
      );
    }
    classNames.push(match[1]);
  }
  return classNames.sort();
}

/**
 * Extract the names of every class imported from
 * './<timestamp>-...' in the canonical manifest. The import block
 * captures multiple classes per `import { X, Y } from '...';`
 * statement (rare for migrations but cheap to support).
 */
function listImportedMigrationClasses(): string[] {
  const source = readFileSync(MANIFEST_PATH, 'utf8');
  const importRegex = /import\s*\{([^}]+)\}\s*from\s*['"]\.\/\d{13}-[^'"]+['"]\s*;/g;
  const names: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = importRegex.exec(source)) !== null) {
    const inner = m[1];
    if (!inner) {
      continue;
    }
    for (const raw of inner.split(',')) {
      const ident = raw
        .trim()
        .replace(/^type\s+/, '')
        .replace(/\s+as\s+\w+$/, '');
      if (MIGRATION_CLASS_REGEX.test(ident)) {
        names.push(ident);
      }
    }
  }
  return names.sort();
}

/**
 * Extract the names listed inside the FARM_MIGRATIONS manifest array.
 */
function listArrayMigrationClasses(): string[] {
  const source = readFileSync(MANIFEST_PATH, 'utf8');
  const match = source.match(/export\s+const\s+FARM_MIGRATIONS\s*=\s*\[([\s\S]*?)\]\s+as\s+const/);
  if (!match || !match[1]) {
    throw new Error(
      `Could not locate the FARM_MIGRATIONS array in ${MANIFEST_PATH}. ` +
        'Either the manifest was renamed/moved (update this invariant) or ' +
        'the file is unreadable.',
    );
  }
  const body = match[1];
  const names: string[] = [];
  // Each line that contains a class identifier is a migration entry.
  // Lines that are pure comments are ignored — the regex requires the
  // identifier to be preceded by start-of-line whitespace, not a `//`.
  //
  // Trailing punctuation is `,` OR end-of-line — the latter covers
  // single-element arrays where the only entry has no trailing comma.
  // (The outer FARM_MIGRATIONS match already strips the surrounding
  // `[ … ]`, so the close bracket never appears in `body` and a
  // bracket-based pattern can't match it.) Post-ADR-030 the manifest is
  // `[Baseline1800000000000]` (one entry, no trailing comma); the
  // previous comma-only pattern silently returned `inArray = []` and
  // tripped the orphaned-imported check.
  const entryRegex = /^\s*([A-Z][A-Za-z0-9]*\d{13})\s*(?:,|$)/gm;
  let m: RegExpExecArray | null;
  while ((m = entryRegex.exec(body)) !== null) {
    const migrationClass = m[1];
    if (migrationClass) {
      names.push(migrationClass);
    }
  }
  return names.sort();
}

describe('farm-service migration array completeness (FARM-LOW-001 follow-up)', () => {
  let onDisk: string[];
  let imported: string[];
  let inArray: string[];

  beforeAll(() => {
    onDisk = listOnDiskMigrationClasses();
    imported = listImportedMigrationClasses();
    inArray = listArrayMigrationClasses();
  });

  it('finds at least 1 on-disk migration (sanity — confirms the scan works)', () => {
    // Post-ADR-030 day-one reset farm-service ships exactly 1 baseline
    // (apps/farm-service/src/database/migrations/1800000000000-Baseline.ts) +
    // any post-reset add-ons. The pre-reset >=20 floor was tied to the
    // ~25-file archaeology chain that's now archived. A single-digit
    // floor still catches "scan returned empty" regressions.
    expect(onDisk.length).toBeGreaterThanOrEqual(1);
  });

  it('AppModule delegates runtime migrations to FARM_MIGRATIONS', () => {
    const source = readFileSync(APP_MODULE_PATH, 'utf8');
    expect(source).toMatch(
      /import\s+\{\s*FARM_MIGRATIONS\s*\}\s+from\s+['"]\.\/database\/migrations\/manifest['"]/,
    );
    expect(source).toMatch(/migrations:\s*\[\s*\.\.\.FARM_MIGRATIONS\s*\]/);
  });

  it('every on-disk migration class is imported in manifest.ts', () => {
    const missing = onDisk.filter((cls) => !imported.includes(cls)).sort();
    expect(missing).toEqual([]);
  });

  it('every imported migration class exists on disk', () => {
    const stale = imported.filter((cls) => !onDisk.includes(cls)).sort();
    expect(stale).toEqual([]);
  });

  it('every imported migration class appears in FARM_MIGRATIONS', () => {
    const orphaned = imported.filter((cls) => !inArray.includes(cls)).sort();
    expect(orphaned).toEqual([]);
  });

  it('every entry in FARM_MIGRATIONS is imported', () => {
    const phantom = inArray.filter((cls) => !imported.includes(cls)).sort();
    expect(phantom).toEqual([]);
  });

  it('db-migrate farm glob excludes manifest.ts to avoid duplicate TypeORM migration classes', () => {
    const source = readFileSync(DB_MIGRATE_SCHEMA_REGISTRY_PATH, 'utf8');
    expect(source).toContain("'apps/farm-service/src/database/migrations/[0-9]*{.ts,.js}'");
    expect(source).not.toContain("'apps/farm-service/src/database/migrations/*{.ts,.js}'");
  });

  it('TypeORM CLI data-source also excludes manifest.ts from migration discovery', () => {
    const source = readFileSync(DATA_SOURCE_PATH, 'utf8');
    expect(source).toContain("'src/database/migrations/[0-9]*.ts'");
    expect(source).not.toContain("'src/database/migrations/*.ts'");
  });

  it('equipment type subtype codes use native text[] from entity through seed and E2E DDL', () => {
    const entitySrc = readFileSync(EQUIPMENT_TYPE_ENTITY_PATH, 'utf8');
    const seedSrc = readFileSync(FARM_SEED_PATH, 'utf8');
    const harnessSrc = readFileSync(TENANT_SCHEMA_HARNESS_PATH, 'utf8');

    expect(entitySrc).toMatch(
      /@Column\(\s*['"]text['"],\s*\{\s*array:\s*true,\s*nullable:\s*true\s*\}\s*\)/s,
    );
    expect(seedSrc).toMatch(/et\.allowedSubEquipmentTypes\s*\|\|\s*\[\]/);
    expect(seedSrc).not.toMatch(/JSON\.stringify\(\s*et\.allowedSubEquipmentTypes/);
    expect(harnessSrc).toMatch(/"allowedSubEquipmentTypes"\s+TEXT\[\]\s+NULL/i);
  });

  it('equipment_types baseline and forward repair expose the runtime camelCase contract', () => {
    const baselineSrc = readFileSync(FARM_BASELINE_PATH, 'utf8');
    const repairSrc = readFileSync(FARM_EQUIPMENT_TYPES_REPAIR_PATH, 'utf8');

    for (const source of [baselineSrc, repairSrc]) {
      expect(source).toContain('"specificationSchema"');
      expect(source).toContain('"allowedSubEquipmentTypes"');
      expect(source).toContain('"isActive"');
      expect(source).toContain('"isSystem"');
      expect(source).toContain('"sortOrder"');
      expect(source).toContain('"createdAt"');
      expect(source).toContain('"updatedAt"');
      expect(source).toContain("'pond'");
      expect(source).toContain("'cage'");
    }

    const baselineCreate =
      baselineSrc.match(/CREATE TABLE IF NOT EXISTS "farm"\."equipment_types" \(([^`]+)\)`/)?.[1] ?? '';
    expect(baselineCreate).not.toContain('"specification_schema"');
    expect(baselineCreate).not.toContain('"allowed_sub_equipment_types"');
    expect(baselineCreate).not.toContain('"is_active" boolean NOT NULL DEFAULT true');
    expect(repairSrc).toMatch(/postCondition\(queryRunner: QueryRunner\): Promise<boolean>/);
    expect(repairSrc).toContain('current_schema()');
  });
});
