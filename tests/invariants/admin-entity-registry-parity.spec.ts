import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * INVARIANT: every admin-schema entity table is registered in
 * MODULE_SCHEMAS['admin'] (DB-ADMIN-MEDIUM-002).
 *
 * WHY: admin is a platform-level (cross-tenant) service — every `@Entity(...,
 * { schema: 'admin' })` table must appear in the service's `MODULE_SCHEMAS`
 * entry (`schema-manager.service.ts`), because the ADR-012 drift validator and
 * the orphan-drop presence checks both iterate that registry. An UNregistered
 * real table is invisible to both: it is neither reconciled (drift) nor
 * protected (an orphan-drop sweep that trusts the registry as the allowlist
 * could target it). 13 admin tables (discount_codes, module_pricing,
 * plan_definitions, plan_module_assignments, threat_intelligence,
 * retention_policies, retired_schema_backups, database_metrics, slow_query_logs,
 * ingest_backend_policy_state, announcements, job_queues, system_versions) had
 * drifted out of the registry undetected — no invariant covered platform-service
 * entity↔registry parity. This spec is that guard; it fails the build listing any
 * admin entity whose table is not in the admin registry block.
 */

const REPO_ROOT = resolve(__dirname, '..', '..');
const ADMIN_SRC = resolve(REPO_ROOT, 'apps/admin-api-service/src');
const SCHEMA_MANAGER = resolve(
  REPO_ROOT,
  'libs/backend-common/src/database/schema-manager.service.ts',
);

/** Recursively collect *.entity.ts under admin-api/src, excluding archives/tests/migrations. */
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

describe("INVARIANT: admin-schema entities are all registered in MODULE_SCHEMAS['admin'] (DB-ADMIN-MEDIUM-002)", () => {
  it('no @Entity(..., { schema: admin }) table is missing from the admin registry block', () => {
    // 1. Source of truth: table names declared @Entity(..., { schema: 'admin' }).
    const entityTables = new Set<string>();
    const decl = /@Entity\(\s*'([a-z_]+)'\s*,\s*\{[^}]*schema:\s*'admin'/g;
    for (const file of collectEntityFiles(ADMIN_SRC)) {
      const text = readFileSync(file, 'utf8');
      let m: RegExpExecArray | null;
      while ((m = decl.exec(text)) !== null) {
        entityTables.add(m[1]);
      }
    }
    // Guard against a regex/glob regression silently passing the assertion.
    expect(entityTables.size).toBeGreaterThan(40);

    // 2. Registered names in the admin MODULE_SCHEMAS block (tables + infra + ref).
    const sm = readFileSync(SCHEMA_MANAGER, 'utf8');
    const start = sm.indexOf("moduleName: 'admin'");
    const end = sm.indexOf("moduleName: 'auth'", start);
    const adminBlock = sm.slice(start, end);
    const registered = new Set(
      (adminBlock.match(/'[a-z_]+'/g) ?? []).map((s) => s.replace(/'/g, '')),
    );

    // 3. Every declared admin table must be registered.
    const missing = [...entityTables].filter((t) => !registered.has(t)).sort();
    expect(missing).toEqual([]);
  });
});
