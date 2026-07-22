/**
 * APA-052 Tier-3 gate — admin-api raw SQL must schema-qualify every table that
 * lives OUTSIDE the admin search_path.
 *
 * admin-api runs with search_path=admin,public (typeorm-config.factory.ts;
 * app.module.ts schema:'admin'). The tenant/user SSoT tables live in the `auth`
 * schema, which is NOT on the search_path, so a bare `FROM tenants` throws
 * `relation "tenants" does not exist` at runtime — and where it is wrapped in a
 * swallowing catch (getTenantName), it silently returns null/empty. A prior
 * grep-based rewrite (see analytics/services/reports.service.ts) missed sites
 * because it matched a single fixed spacing; this parses FROM/JOIN targets after
 * stripping comments so multi-space / newline forms cannot slip through again.
 *
 * The table set is deliberately limited to relations that admin does NOT own
 * (tenants/users/refresh_tokens/invitations all live only in `auth`). Tables
 * admin owns in its own schema — e.g. admin.audit_logs, admin.user_sessions —
 * are correctly resolved by the search_path and are NOT listed, so a legitimate
 * bare reference to an admin-owned table is never a false positive.
 *
 * @see docs/reviews/claude/2026-07-20-admin-panel-e2e-audit/findings/users-roles.md#APA-052
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC_ROOT = join(__dirname, '..', '..'); // apps/admin-api-service/src

/** auth-schema SSoT tables — never present on the admin search_path. */
const CROSS_SCHEMA_TABLES = ['tenants', 'users', 'refresh_tokens', 'invitations'];

function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === '__tests__' || name === 'node_modules' || name === '.archive') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      collectSourceFiles(full, acc);
    } else if (name.endsWith('.ts') && !name.endsWith('.spec.ts')) {
      acc.push(full);
    }
  }
  return acc;
}

/** Strip block + line comments so doc-comment prose is not scanned as SQL. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

describe('admin-api raw SQL cross-schema qualification (APA-052)', () => {
  // Bare FROM/JOIN of an auth-schema table (no `<schema>.` qualifier). A
  // qualified reference (auth.tenants) has the schema token immediately after
  // FROM/JOIN and therefore does not match.
  const bareRef = new RegExp(
    String.raw`\b(?:FROM|JOIN)\s+(?:${CROSS_SCHEMA_TABLES.join('|')})\b`,
    'gi',
  );

  it('never references an auth-schema table without a schema qualifier', () => {
    const violations: string[] = [];
    for (const file of collectSourceFiles(SRC_ROOT)) {
      const src = stripComments(readFileSync(file, 'utf8'));
      for (const match of src.matchAll(bareRef)) {
        violations.push(
          `${file.slice(SRC_ROOT.length + 1)}: '${match[0].replace(/\s+/g, ' ')}'`,
        );
      }
    }
    expect(violations).toEqual([]);
  });
});
