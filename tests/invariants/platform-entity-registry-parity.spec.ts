import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * INVARIANT: every platform-level-service entity table is registered in that
 * service's MODULE_SCHEMAS entry (DB-ADMIN-MEDIUM-002, generalized).
 *
 * WHY: platform-level services own cross-tenant schemas. Every `@Entity(...,
 * { schema: '<svc>' })` table must appear in the service's `MODULE_SCHEMAS`
 * entry (`schema-manager.service.ts`), because the ADR-012 drift validator and
 * the orphan-drop presence checks both iterate that registry — an UNregistered
 * real table is neither reconciled nor protected. admin had drifted 13 tables out
 * of its registry undetected; billing had drifted 2 (`plans`,
 * `stripe_webhook_events`). No invariant covered platform-service entity↔registry
 * parity, so the drift was invisible. This spec is that guard, per schema.
 *
 * NOTE — observability is deliberately NOT covered yet: observability-service has
 * `schema: 'observability'` entities but NO `MODULE_SCHEMAS['observability']`
 * entry at all (a larger fix — a new registry entry + drift-validator wiring),
 * tracked separately. Adding observability here would (correctly) fail until that
 * entry exists; it is listed in KNOWN_UNREGISTERED so this guard stays honest
 * about what it does and does not yet cover.
 */

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCHEMA_MANAGER = resolve(
  REPO_ROOT,
  'libs/backend-common/src/database/schema-manager.service.ts',
);

/** schema → app source dir, for platform-level services WITH a MODULE_SCHEMAS entry. */
const COVERED: ReadonlyArray<{ schema: string; appDir: string; minEntities: number }> = [
  { schema: 'admin', appDir: 'apps/admin-api-service/src', minEntities: 40 },
  { schema: 'billing', appDir: 'apps/billing-service/src', minEntities: 8 },
  { schema: 'notification', appDir: 'apps/notification-service/src', minEntities: 2 },
  { schema: 'config', appDir: 'apps/config-service/src', minEntities: 2 },
  { schema: 'event_store', appDir: 'apps/event-store-service/src', minEntities: 5 },
  // Registry-completeness sweep (ORPHAN-HIGH-365 / ORPHAN-MEDIUM-362 follow-on):
  { schema: 'observability', appDir: 'apps/observability-service/src', minEntities: 4 },
  // compliance's LegalHold entity is a backend-common shared-lib entity (the
  // legal-hold gate is enforced platform-wide); admin-api's migration created
  // the physical schema.
  { schema: 'compliance', appDir: 'libs/backend-common/src', minEntities: 1 },
];

/**
 * Raw-SQL infrastructure schemas: registered in MODULE_SCHEMAS but with NO
 * TypeORM entities by design (db-migrate/bootstrap-owned tables). The guard
 * asserts the registry entry EXISTS and that no entity ever declares the
 * schema — if one appears, the schema must move into COVERED.
 */
const RAW_SQL_INFRA_SCHEMAS = ['platform'];

function collectEntityFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '.archive' || entry === '__tests__' || entry === 'migrations') continue;
      out.push(...collectEntityFiles(full));
    } else if (entry.endsWith('.entity.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Table names declared `@Entity('name', { schema: '<schema>' })` under appDir. */
function entityTablesFor(appDir: string, schema: string): Set<string> {
  const tables = new Set<string>();
  const decl = new RegExp(`@Entity\\(\\s*'([a-z_]+)'\\s*,\\s*\\{[^}]*schema:\\s*'${schema}'`, 'g');
  for (const file of collectEntityFiles(resolve(REPO_ROOT, appDir))) {
    const text = readFileSync(file, 'utf8');
    let m: RegExpExecArray | null;
    while ((m = decl.exec(text)) !== null) {
      const table = m[1];
      // Group 1 is non-optional in the pattern; the guard narrows the
      // RegExpExecArray index type (string | undefined) for strict tsc.
      if (table !== undefined) {
        tables.add(table);
      }
    }
  }
  return tables;
}

/** Quoted identifiers inside the MODULE_SCHEMAS block for `schema` (tables + infra + ref). */
function registeredTablesFor(schemaManagerSrc: string, schema: string): Set<string> {
  const start = schemaManagerSrc.indexOf(`moduleName: '${schema}'`);
  if (start === -1) return new Set();
  // Block ends at the next `moduleName:` (or EOF).
  const nextModule = schemaManagerSrc.indexOf('moduleName:', start + 1);
  const end = nextModule === -1 ? schemaManagerSrc.length : nextModule;
  const block = schemaManagerSrc.slice(start, end);
  return new Set((block.match(/'[a-z_]+'/g) ?? []).map((s) => s.replace(/'/g, '')));
}

describe('INVARIANT: platform-service entities are all registered in MODULE_SCHEMAS (DB-ADMIN-MEDIUM-002)', () => {
  const sm = readFileSync(SCHEMA_MANAGER, 'utf8');

  it.each(COVERED)(
    "$schema: no @Entity(..., { schema: $schema }) table is missing from MODULE_SCHEMAS['$schema']",
    ({ schema, appDir, minEntities }) => {
      const entityTables = entityTablesFor(appDir, schema);
      // Guard against a regex/glob regression silently passing the assertion.
      expect(entityTables.size).toBeGreaterThanOrEqual(minEntities);

      const registered = registeredTablesFor(sm, schema);
      const missing = [...entityTables].filter((t) => !registered.has(t)).sort();
      expect(missing).toEqual([]);
    },
  );

  it.each(RAW_SQL_INFRA_SCHEMAS)(
    '%s: registered in MODULE_SCHEMAS with NO TypeORM entities (raw-SQL infra schema)',
    (schema) => {
      // The registry entry must exist (a complete map of every non-tenant schema)…
      expect(sm.includes(`moduleName: '${schema}'`)).toBe(true);
      // …and no entity may declare the schema. If one appears, the schema has
      // gained an ORM surface and must move into COVERED with its owning appDir.
      const decl = new RegExp(`schema:\\s*'${schema}'`);
      const offenders: string[] = [];
      for (const appDir of readdirSync(resolve(REPO_ROOT, 'apps'))) {
        const src = resolve(REPO_ROOT, 'apps', appDir, 'src');
        try {
          for (const file of collectEntityFiles(src)) {
            if (decl.test(readFileSync(file, 'utf8'))) {
              offenders.push(file.replace(`${REPO_ROOT}/`, ''));
            }
          }
        } catch {
          // apps/<name> without a src dir (e.g. tooling packages) — skip.
        }
      }
      expect(offenders).toEqual([]);
    },
  );
});
