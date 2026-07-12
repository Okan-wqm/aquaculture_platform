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
];

/** Platform services known to lack a MODULE_SCHEMAS entry — tracked follow-on, not covered here. */
const KNOWN_UNREGISTERED = ['observability'];

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

  it('KNOWN_UNREGISTERED platform services really do lack a MODULE_SCHEMAS entry (keeps the exclusion honest)', () => {
    // If one of these gains an entry, add it to COVERED and drop it here — this
    // assertion fails the moment the tracked gap is closed, forcing the update.
    for (const schema of KNOWN_UNREGISTERED) {
      expect(sm.includes(`moduleName: '${schema}'`)).toBe(false);
    }
  });
});
