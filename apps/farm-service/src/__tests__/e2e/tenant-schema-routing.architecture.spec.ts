/**
 * Tenant schema routing architecture invariants.
 *
 * WHY: farm-service uses schema-per-tenant routing through PostgreSQL
 * search_path. Tenant-owned entities must not pin `schema: 'farm'`, because
 * explicit schema-qualified SQL bypasses TenantConnectionBootstrap and can
 * write/read source-schema data instead of the current tenant schema.
 *
 * SSoT DERIVATION (Tier-1 make-impossible): the set of farm tables that
 * legitimately DO live in the source `farm` schema (and therefore MAY pin
 * `schema: 'farm'`) is NOT hand-maintained in this spec. It is derived at
 * test time from `MODULE_SCHEMAS[farm].infrastructureTables` in
 * `@aquaculture/backend-common` — the single source of truth that
 * `SourceSchemaBootstrapService` already uses to decide which farm tables
 * are cross-tenant infrastructure (outbox, audit ledgers, GDPR erasure
 * ledger) versus per-tenant clones. Adding a future cross-tenant table to
 * MODULE_SCHEMAS therefore AUTO-EXTENDS this gate's allowlist; nothing in
 * this file needs editing. This kills the stale-allowlist failure mode where
 * the spec false-positive-failed on correctly-pinned cross-tenant tables
 * (`farm_audit_logs`, `tenant_erasure_audit`) that the old hardcoded
 * one-entry allowlist did not list.
 *
 * BELT + SUSPENDERS (fail-closed): the reverse-coverage assertion below
 * checks that EVERY `schema: 'farm'` entity's declared table name is present
 * in `infrastructureTables`. A per-tenant entity that wrongly pins
 * `schema: 'farm'` but is NOT a declared infrastructure table still trips the
 * gate — the SSoT can only widen the allowlist for tables it actually
 * declares as cross-tenant, never for an arbitrary mis-pinned entity.
 */
import * as fs from 'fs';
import * as path from 'path';

import { MODULE_SCHEMAS } from '@aquaculture/backend-common';

const SRC_ROOT = path.resolve(__dirname, '../../');

/**
 * Matches any entity decorator that pins the source `farm` schema, in either
 * TypeORM call shape:
 *   - @Entity('table_name', { schema: 'farm' })
 *   - @Entity({ schema: 'farm', name: 'table_name' })
 * The `[^)]*` body is single-decorator-bounded so it never bleeds across a
 * closing paren into an unrelated following decorator.
 */
const SCHEMA_FARM_ENTITY_RE = /@Entity\([^)]*schema:\s*'farm'/;

/**
 * The farm cross-tenant infrastructure-table SSoT. These tables legitimately
 * live in the source `farm` schema and are NOT per-tenant cloned by
 * TenantSchemaSyncService, so the entities that map them MAY pin
 * `schema: 'farm'`. Derived — not hardcoded — so the gate tracks the SSoT.
 */
function farmInfrastructureTables(): ReadonlySet<string> {
  const farmModule = MODULE_SCHEMAS.find((m) => m.moduleName === 'farm');
  if (!farmModule) {
    throw new Error(
      "MODULE_SCHEMAS has no 'farm' module entry — the SSoT this gate derives " +
        'its allowlist from is missing. Cannot evaluate tenant schema routing.',
    );
  }
  return new Set(farmModule.infrastructureTables ?? []);
}

function findEntityFiles(dir: string): string[] {
  const files: string[] = [];

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && !entry.name.startsWith('.')) {
        files.push(...findEntityFiles(fullPath));
      }
      continue;
    }

    if (entry.isFile() && entry.name.endsWith('.entity.ts')) {
      files.push(fullPath);
    }
  }

  return files;
}

/**
 * Extract the declared table name from a `schema: 'farm'`-pinned `@Entity()`
 * decorator. Handles both TypeORM call shapes:
 *   - @Entity('table_name', { schema: 'farm' })  → first positional string arg
 *   - @Entity({ name: 'table_name', schema: 'farm' })  → `name:` property
 * Returns `null` when no table name can be resolved (e.g. an entity that pins
 * the schema but relies on TypeORM's class-name-derived default table name) —
 * the caller treats that as an un-allowlistable violation, which is correct:
 * a cross-tenant infra table must declare its name explicitly to be matched
 * against the SSoT.
 */
function extractFarmEntityTableName(content: string): string | null {
  // Isolate the @Entity(...) argument list. Single-decorator-bounded `[^)]*`
  // mirrors SCHEMA_FARM_ENTITY_RE so we parse exactly the matched decorator.
  const decoratorMatch = content.match(/@Entity\(([^)]*)\)/);
  const args = decoratorMatch?.[1];
  if (args === undefined) {
    return null;
  }

  // Shape A: @Entity({ ..., name: 'table_name', ... }) — explicit `name:` prop.
  const nameProp = args.match(/name:\s*'([^']+)'/)?.[1];
  if (nameProp !== undefined) {
    return nameProp;
  }

  // Shape B: @Entity('table_name', { schema: 'farm' }) — first positional
  // string literal. The `^\s*` anchor ensures we read the FIRST argument, not
  // a string literal nested inside the options object.
  const positional = args.match(/^\s*'([^']+)'/)?.[1];
  if (positional !== undefined) {
    return positional;
  }

  return null;
}

/**
 * All farm `*.entity.ts` files that pin `schema: 'farm'`, with their declared
 * table name resolved from the decorator. Computed once and shared by every
 * assertion so the filesystem walk + parse runs a single time.
 */
function collectSchemaFarmEntities(): ReadonlyArray<{
  relativePath: string;
  tableName: string | null;
}> {
  return findEntityFiles(SRC_ROOT)
    .map((file) => ({
      relativePath: path.normalize(path.relative(SRC_ROOT, file)),
      content: fs.readFileSync(file, 'utf-8'),
    }))
    .filter(({ content }) => SCHEMA_FARM_ENTITY_RE.test(content))
    .map(({ relativePath, content }) => ({
      relativePath,
      tableName: extractFarmEntityTableName(content),
    }));
}

describe('Tenant schema routing architecture', () => {
  it('keeps tenant-owned entities unqualified so search_path controls tenant isolation', () => {
    const allowed = farmInfrastructureTables();

    // A violation is any `schema: 'farm'` entity whose declared table is NOT
    // a cross-tenant infrastructure table in the SSoT. The two correctly-
    // pinned ledgers (farm_audit_logs, tenant_erasure_audit) and the outbox
    // (outbox_events) are all in `infrastructureTables`, so they pass; a
    // per-tenant entity that wrongly pins `schema: 'farm'` does not.
    const violations = collectSchemaFarmEntities()
      .filter(({ tableName }) => tableName === null || !allowed.has(tableName))
      .map(({ relativePath }) => relativePath);

    expect(violations).toEqual([]);
  });

  it('derives its allowlist from the MODULE_SCHEMAS SSoT (no hardcoded entity list)', () => {
    // The allowlist is the farm infrastructure-table SSoT, not a literal set
    // baked into this spec. Asserting the SSoT carries the known cross-tenant
    // farm tables proves the derivation resolves and is non-empty — a future
    // refactor that emptied MODULE_SCHEMAS[farm].infrastructureTables would
    // turn the green-path assertion into a false pass without this guard.
    const allowed = farmInfrastructureTables();

    expect(allowed.has('outbox_events')).toBe(true);
    expect(allowed.has('farm_audit_logs')).toBe(true);
    expect(allowed.has('tenant_erasure_audit')).toBe(true);
  });

  it('resolves to exactly the current schema:farm entities on the real source tree', () => {
    // Green-path coverage: the real farm source tree has precisely three
    // `schema: 'farm'` entities (outbox_events, farm_audit_logs,
    // tenant_erasure_audit). All three resolve a table name and all three are
    // in the SSoT allowlist. This pins the current truth so an entity that
    // newly pins `schema: 'farm'` (without an SSoT entry) flips this count and
    // is caught by the green-path test above.
    const tableNames = collectSchemaFarmEntities()
      .map(({ tableName }) => tableName)
      .filter((name): name is string => name !== null)
      .sort();

    expect(tableNames).toEqual(['farm_audit_logs', 'outbox_events', 'tenant_erasure_audit']);
  });

  it('requires every schema:farm entity table to be a declared infrastructure table (fail-closed)', () => {
    // Reverse-coverage / belt + suspenders: the forward green-path test proves
    // no entity sits OUTSIDE the allowlist; this proves no `schema: 'farm'`
    // entity exists whose table is absent from the SSoT. Together they make a
    // mis-pinned per-tenant entity impossible to ship silently — it must
    // either drop `schema: 'farm'` (correct for per-tenant) or be added to
    // MODULE_SCHEMAS[farm].infrastructureTables as a deliberate, reviewed
    // cross-tenant declaration.
    const allowed = farmInfrastructureTables();
    const uncovered = collectSchemaFarmEntities()
      .filter(({ tableName }) => tableName === null || !allowed.has(tableName))
      .map(({ relativePath, tableName }) => ({ relativePath, tableName }));

    expect(uncovered).toEqual([]);
  });

  describe('fail-closed mutation proof', () => {
    // NEGATIVE / mutation test: prove the gate actually FAILS on a genuinely
    // mis-pinned per-tenant entity. We synthesize the exact decorator shape a
    // mistaken author would write — a per-tenant table pinning `schema: 'farm'`
    // with a name that is NOT in the infrastructure SSoT — and assert the same
    // detection logic the gate uses flags it. This is what makes the green
    // assertions above meaningful: they pass because the tree is correct, not
    // because the matcher is inert.
    const MISPINNED_ENTITY_FIXTURE = `
      @Entity('ponds', { schema: 'farm' })
      export class MisPinnedPondEntity {}
    `;

    it('flags a per-tenant table that wrongly pins schema:farm', () => {
      const allowed = farmInfrastructureTables();

      expect(SCHEMA_FARM_ENTITY_RE.test(MISPINNED_ENTITY_FIXTURE)).toBe(true);

      const tableName = extractFarmEntityTableName(MISPINNED_ENTITY_FIXTURE);
      expect(tableName).toBe('ponds');

      // `ponds` is a per-tenant farm table (it is in MODULE_SCHEMAS[farm].tables,
      // never in infrastructureTables), so the gate's predicate marks it a
      // violation — fail-closed.
      const isViolation = tableName === null || !allowed.has(tableName);
      expect(isViolation).toBe(true);
    });

    it('flags a schema:farm entity that declares no resolvable table name', () => {
      // An entity that pins the schema but relies on TypeORM's class-name
      // default table name cannot be matched against the SSoT, so it is a
      // violation by construction (a cross-tenant infra table must name itself
      // explicitly to be allowlisted).
      const NAMELESS_FIXTURE = `@Entity({ schema: 'farm' })\nexport class Nameless {}`;
      const allowed = farmInfrastructureTables();

      expect(SCHEMA_FARM_ENTITY_RE.test(NAMELESS_FIXTURE)).toBe(true);
      const tableName = extractFarmEntityTableName(NAMELESS_FIXTURE);
      expect(tableName).toBeNull();

      const isViolation = tableName === null || !allowed.has(tableName);
      expect(isViolation).toBe(true);
    });

    it('accepts a cross-tenant infra table that correctly pins schema:farm', () => {
      // Positive control for the mutation suite: the SAME predicate that
      // rejects `ponds` ACCEPTS a real infrastructure table, proving the gate
      // is not simply rejecting everything.
      const allowed = farmInfrastructureTables();
      const OUTBOX_FIXTURE = `@Entity({ schema: 'farm', name: 'outbox_events', synchronize: false })`;

      expect(SCHEMA_FARM_ENTITY_RE.test(OUTBOX_FIXTURE)).toBe(true);
      const tableName = extractFarmEntityTableName(OUTBOX_FIXTURE);
      expect(tableName).toBe('outbox_events');

      const isViolation = tableName === null || !allowed.has(tableName);
      expect(isViolation).toBe(false);
    });
  });
});
