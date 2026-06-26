/**
 * Platform-wide invariant — Config/Schema SSoT (Cluster 3b):
 *
 * A service's RLS `excludeTables` set IS its cross-tenant infrastructure-table
 * set (`MODULE_SCHEMAS[].infrastructureTables`). CLAUDE.md (ADR-011/012) mandates
 * "do not hardcode a copy" of that set. Service `app.module.ts` callsites must
 * pass `excludeTables: getRlsExcludeTablesForService('<service>')`, never an
 * inline literal array — the prior farm copy carried phantom
 * `audit_logs`/`audit_log` and omitted the real `farm_audit_logs`.
 *
 * Documented exemptions (a literal is correct there):
 *   - auth-service: a cross-tenant platform service whose RLS exclusion
 *     legitimately covers DOMAIN tables (`users`, `tenants`) that are not
 *     "infrastructure" — they cannot be derived from infrastructureTables.
 *   - observability-service: not a per-tenant MODULE_SCHEMAS schema; its
 *     `excludeTables: []` is intentional.
 */

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

const EXEMPT_LITERAL = new Set([
  'apps/auth-service/src/app.module.ts',
  'apps/observability-service/src/app.module.ts',
]);

function gitGrepFiles(pattern: string): string[] {
  let out = '';
  try {
    out = execFileSync('git', ['-C', REPO_ROOT, 'grep', '-l', '-E', pattern], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return [];
  }
  return out.split('\n').filter(Boolean);
}

describe('INVARIANT (SSOT 3b): RLS excludeTables derive from MODULE_SCHEMAS', () => {
  it('no service app.module.ts inlines a literal RLS excludeTables array', () => {
    const offenders = gitGrepFiles('excludeTables:\\s*\\[')
      .filter((f) => /^apps\/[^/]+\/src\/app\.module\.ts$/.test(f))
      .filter((f) => !EXEMPT_LITERAL.has(f));
    expect(offenders).toEqual([]);
  });

  it('getRlsExcludeTablesForService is declared exactly once (the schema-manager SSoT)', () => {
    const decls = gitGrepFiles('export function getRlsExcludeTablesForService\\b').filter(
      (f) => !f.endsWith('.spec.ts') && !f.includes('/__tests__/'),
    );
    expect(decls).toEqual([
      'libs/backend-common/src/database/schema-manager.service.ts',
    ]);
  });
});
