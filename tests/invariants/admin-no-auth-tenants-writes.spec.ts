/**
 * Admin no-auth.tenants-writes invariant (DB-ADMIN-HIGH-004 / ORPHAN-HIGH-360)
 * ============================================================================
 *
 * auth-service is the SINGLE WRITER of auth.tenants (D14: the authoritative
 * tenant record; login resolves it first). Admin-api delegates every tenant
 * lifecycle mutation over NATS request/reply
 * (AuthTenantProvisioningClientService → TENANT_COMMAND_SUBJECTS) and only
 * READS the row back. The pre-fix dual-write fork — the four lifecycle
 * handlers calling `save(Tenant, tenant)` after the NATS reply — raced the
 * owner's SERIALIZABLE receipt transaction and silently dropped the
 * non-persisted suspension props (DB-ADMIN-HIGH-003).
 *
 * This spec makes the wrong behaviour detectable at CI time: any TypeORM
 * write call targeting the admin Tenant entity inside
 * apps/admin-api-service/src (tests and migrations excluded) fails here.
 *
 * # When this spec fails
 *
 *   - New `save(Tenant`/`update(Tenant`/`insert(Tenant` call in admin-api →
 *     move the mutation to auth-service and delegate via
 *     AuthTenantProvisioningClientService (extend the NATS contract if the
 *     command does not exist yet).
 *   - A genuinely reviewed cross-service flow needs a write → it requires an
 *     architectural-arbiter review AND an entry in ALLOWLISTED_WRITERS below
 *     with the WHY.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ADMIN_API_SRC = path.resolve(REPO_ROOT, 'apps/admin-api-service/src');

/**
 * Files allowed to write the Tenant entity, relative to admin-api src.
 *
 * tenant-erasure.handler.ts: the GDPR Art 17 erasure saga's terminal step
 * writes status=PURGED after the cross-service erasure completes. It is a
 * reviewed cross-service flow (legal-hold gated, proof-hashed, outbox-evented)
 * that predates the single-writer repair; migrating the PURGED transition to
 * an auth-service-owned NATS command is TRACKED work under the DB-audit lane
 * (see docs/reviews/orphan-findings.md#ORPHAN-HIGH-360 follow-up scope) — the
 * allowlist entry keeps the exception explicit and unique instead of silent.
 */
const ALLOWLISTED_WRITERS: ReadonlySet<string> = new Set([
  'tenant/handlers/tenant-erasure.handler.ts',
]);

/**
 * TypeORM write calls that target the Tenant entity class. Matches
 * `save(Tenant`, `update(Tenant`, `insert(Tenant` — i.e.
 * `manager.save(Tenant, …)`, `repo.update(Tenant, …)` and friends. Raw-SQL
 * writes to auth.tenants are covered by the sibling patterns below.
 */
const ENTITY_WRITE_PATTERN =
  /\b(?:save|update|insert|upsert|delete|remove|softDelete|softRemove|restore)\(Tenant[,)]/;

/** Raw SQL writes against the owner's table are the same violation. */
const RAW_SQL_WRITE_PATTERN = /\b(?:UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+"?auth"?\."?tenants"?/i;

function walkSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Tests may mock/save freely; migrations are admin-schema DDL history.
      if (entry.name === '__tests__' || entry.name === 'migrations') continue;
      out.push(...walkSourceFiles(abs));
    } else if (entry.isFile() && abs.endsWith('.ts') && !abs.endsWith('.spec.ts')) {
      out.push(abs);
    }
  }
  return out;
}

describe('DB-ADMIN-HIGH-004 — admin-api never writes auth.tenants (single-writer: auth-service)', () => {
  // Fail-closed by design: if the admin-api source tree vanished the walk
  // throws and the suite is red — a single-writer invariant must never
  // silently skip itself open.
  const files = walkSourceFiles(ADMIN_API_SRC);

  it('scans a non-empty admin-api source tree', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('every Tenant-entity write outside the allowlist is a violation', () => {
    const violations: string[] = [];
    for (const file of files) {
      const rel = path.relative(ADMIN_API_SRC, file);
      if (ALLOWLISTED_WRITERS.has(rel)) continue;
      const text = readFileSync(file, 'utf8');
      for (const [index, line] of text.split('\n').entries()) {
        if (ENTITY_WRITE_PATTERN.test(line) || RAW_SQL_WRITE_PATTERN.test(line)) {
          violations.push(`${rel}:${index + 1}: ${line.trim()}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('allowlist entries exist on disk (no stale exception rides forever)', () => {
    for (const rel of ALLOWLISTED_WRITERS) {
      const abs = path.join(ADMIN_API_SRC, rel);
      expect(statSync(abs, { throwIfNoEntry: false })?.isFile()).toBe(true);
    }
  });

  it('the allowlisted erasure handler still writes Tenant (drop the entry when it stops)', () => {
    const abs = path.join(ADMIN_API_SRC, 'tenant/handlers/tenant-erasure.handler.ts');
    const text = readFileSync(abs, 'utf8');
    expect(ENTITY_WRITE_PATTERN.test(text)).toBe(true);
  });
});
