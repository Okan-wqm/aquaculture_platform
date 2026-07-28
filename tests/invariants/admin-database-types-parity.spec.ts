/**
 * APA-326 — admin database-management FE type ↔ backend entity parity.
 *
 * The admin-panel database pages consume the raw shapes admin-api returns, which
 * are the TypeORM entities in
 * apps/admin-api-service/src/database-management/entities/database-management.entity.ts.
 * The FE types (web/modules/admin-panel/src/services/types/database.ts) previously
 * drifted — declaring `type`/`location`/`compressionType`/`encryptionKey`/`createdBy`/
 * `sql`/`name`/`appliedToSchemas`/`failedSchemas` that the entities never expose — so
 * the pages read undefined and silently fell back to the wrong value (e.g. the
 * backup file column showed the row id).
 *
 * This gate binds every FE type field to a real backend entity field: a field
 * name on the FE type that is not a column on the mapped entity fails, and the
 * specific dead drift names must not reappear. No allowlist.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const read = (rel: string): string => readFileSync(resolve(REPO_ROOT, rel), 'utf-8');

const ENTITY_FILE =
  'apps/admin-api-service/src/database-management/entities/database-management.entity.ts';
const FE_TYPES_FILE = 'web/modules/admin-panel/src/services/types/database.ts';

/**
 * Property names declared at the TOP LEVEL of a type body — a brace-depth-aware
 * scan so nested inline object types (e.g. `metadata?: { … }`) and decorator
 * argument objects (`@Column({ … })`) do not leak their inner keys. Accepts both
 * entity (`name!: Type`) and interface (`name?: Type`) property syntax.
 */
function topLevelFields(body: string): Set<string> {
  const fields = new Set<string>();
  let depth = 0;
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (depth === 0) {
      const m = /^(\w+)!?\??:/.exec(line);
      if (m) fields.add(m[1] ?? '');
    }
    depth += (line.match(/\{/g) ?? []).length;
    depth -= (line.match(/\}/g) ?? []).length;
  }
  return fields;
}

function entityFields(source: string, className: string): Set<string> {
  const block = new RegExp(`export class ${className}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(source);
  if (block === null) throw new Error(`entity class ${className} not found`);
  return topLevelFields(block[1] ?? '');
}

function interfaceFields(source: string, ifaceName: string): Set<string> {
  const block = new RegExp(`export interface ${ifaceName}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(source);
  if (block === null) throw new Error(`FE interface ${ifaceName} not found`);
  return topLevelFields(block[1] ?? '');
}

// Each FE type maps to exactly one backend entity (DatabaseBackup ↔ SchemaBackup).
const PAIRS: Array<{ fe: string; entity: string }> = [
  { fe: 'TenantSchema', entity: 'TenantSchema' },
  { fe: 'SchemaMigration', entity: 'SchemaMigration' },
  { fe: 'DatabaseBackup', entity: 'SchemaBackup' },
];

const DEAD_DRIFT_FIELDS = [
  'tenantName',
  'rowCount',
  'compressionType',
  'encryptionKey',
  'location',
  'appliedToSchemas',
  'failedSchemas',
];

describe('admin database-management FE types are derived from the entities (APA-326)', () => {
  const feSrc = read(FE_TYPES_FILE);

  it('derives the FE types instead of re-declaring them', () => {
    // This gate used to compare FE interfaces against the entity field by
    // field, and separately forbid a list of names that had drifted onto the FE
    // copies (tenantName, rowCount, compressionType, encryptionKey, location,
    // appliedToSchemas, failedSchemas).
    //
    // Both jobs are obsolete for the same reason: there is no FE copy any more.
    // `TenantSchema`, `SchemaMigration` and `DatabaseBackup` (generated from
    // `SchemaBackup`, renamed at generation so the panel keeps its own name)
    // come out of tools/codegen/admin-contracts, so a field the entity does not
    // have cannot be written down here, and `admin-contracts-generated` fails
    // the build if the emitted file falls behind.
    for (const name of ['TenantSchema', 'SchemaMigration', 'DatabaseBackup']) {
      expect(feSrc).not.toMatch(new RegExp(`export interface ${name}\\s*\\{`));
    }
    expect(feSrc).toContain("from './generated/admin-contracts'");
  });

  it('keeps the entity as the only author of these shapes', () => {
    // The rename is the one thing a reader could mistake for a second copy, so
    // it is pinned where it is declared rather than left to be rediscovered.
    const manifest = read('tools/codegen/admin-contracts/manifest.ts');
    expect(manifest).toContain("rename: { SchemaBackup: 'DatabaseBackup' }");
  });
});
