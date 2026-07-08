import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Schema role-model + RLS-exclude drift guards (post-#919 mirror audit,
 * DATA-MEDIUM-002 / DATA-MEDIUM-003).
 *
 * Neither of these can be a single imported constant — one side is raw SQL
 * (bootstrap stages cannot import TS) and one side is a deliberately
 * import-free data manifest (schema-registry.ts). So the professional fix is a
 * parity gate: the copies must AGREE, checked at CI time, so the class of drift
 * that silently mis-targets a tenant grant or diverges an RLS-exclude list is
 * caught in the diff rather than in production.
 */
const REPO_ROOT = resolve(__dirname, '..', '..');
function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), 'utf8');
}

describe('schema role-model + RLS-exclude SSoT parity', () => {
  // DATA-MEDIUM-002: the Stage-008 {schema, owner_role, runtime_role,
  // provisioner_role} role map, the SERVICE_ROLES list, and the
  // serviceRoleForTenantAwareSchema('<schema>_service') convention are separate
  // hand-maintained copies. The load-bearing invariant is that a schema's
  // runtime role IS `<schema>_service` — the TS provisioner derives tenant-grant
  // targets from that convention, so a Stage-008 runtime_role that broke it
  // would make the TS grant silently target a wrong/absent role.
  it('every Stage-008 runtime_role follows <schema>_service and is a known SERVICE_ROLE', () => {
    const hardening = read(
      'apps/db-migrate/src/sql/platform-bootstrap/008-least-privilege-hardening.sql',
    );
    const mapEntries = [
      ...hardening.matchAll(
        /\{"schema_name":"([a-z_]+)","owner_role":"([a-z_]+)","runtime_role":"([a-z_]+)"/g,
      ),
    ].map((m) => ({ schema: m[1] as string, runtime: m[3] as string }));
    expect(mapEntries.length).toBeGreaterThanOrEqual(10);

    const bootstrap = read('apps/db-migrate/src/platform-bootstrap.service.ts');
    const serviceRoles = new Set(
      [...bootstrap.matchAll(/\{\s*role:\s*'([a-z_]+)'/g)].map((m) => m[1] as string),
    );
    expect(serviceRoles.has('messaging_service')).toBe(true);

    const violations: string[] = [];
    for (const { schema, runtime } of mapEntries) {
      if (runtime !== `${schema}_service`) {
        violations.push(
          `${schema}: runtime_role "${runtime}" != "${schema}_service" — ` +
            `serviceRoleForTenantAwareSchema() would mis-target it`,
        );
      }
      if (!serviceRoles.has(runtime)) {
        violations.push(`${schema}: runtime_role "${runtime}" is absent from SERVICE_ROLES`);
      }
    }
    expect(violations).toEqual([]);

    // Pin the TS convention itself — if it stops deriving `<schema>_service`,
    // the parity above no longer describes the code that runs.
    const ledger = read(
      'libs/backend-common/src/database/tenant-migration-ledger-privileges.ts',
    );
    expect(ledger).toContain('return `${sourceSchema}_service`;');
  });

  // DATA-MEDIUM-003: auth is the ONE service whose RLS excludes DOMAIN tables
  // (users/tenants), hand-declared in two places. The runtime RlsModule now
  // imports the AUTH_RLS_EXCLUDE_TABLES SSoT; schema-registry.ts keeps a literal
  // (it is deliberately import-free, ADR-033). Pin the literal to the SSoT.
  it('schema-registry auth excludeTables equals the AUTH_RLS_EXCLUDE_TABLES SSoT', () => {
    const schemaManager = read('libs/backend-common/src/database/schema-manager.service.ts');
    const ssotMatch = schemaManager.match(/AUTH_RLS_EXCLUDE_TABLES[^=]*=\s*\[([^\]]*)\]/);
    expect(ssotMatch).not.toBeNull();
    const ssot = [...(ssotMatch?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1] as string);
    expect(ssot).toEqual(['auth_outbox', 'users', 'tenants']);

    const registry = read('apps/db-migrate/src/schema-registry.ts');
    const registryMatch = registry.match(/excludeTables:\s*\['auth_outbox'[^\]]*\]/);
    expect(registryMatch).not.toBeNull();
    const registryList = [...(registryMatch?.[0] ?? '').matchAll(/'([a-z_]+)'/g)].map(
      (m) => m[1] as string,
    );
    expect(registryList).toEqual(ssot);

    // The runtime side actually consumes the SSoT (not its own literal).
    const authModule = read('apps/auth-service/src/app.module.ts');
    expect(authModule).toContain('excludeTables: [...AUTH_RLS_EXCLUDE_TABLES]');
  });
});
