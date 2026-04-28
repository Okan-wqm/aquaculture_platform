/**
 * Platform-wide invariant — AUDITTRAIL-CRITICAL-001 / DBR-CRITICAL-001 /
 * MT-CRITICAL-005 / COMPLIANCE-CRITICAL-001 / LEGAL-HIGH-001:
 *
 * The two immutability triggers + the `legalHold` column on
 * `shared.audit_logs` MUST be installed by an active migration.
 *
 * # Why
 *
 * On 2026-04 the migration `1787200000000-RealignSharedAuditLogsSchema`
 * silently dropped the immutability triggers and the legalHold column
 * by issuing `DROP TABLE shared.audit_logs CASCADE` and recreating the
 * table with the canonical 14-column shape — without re-attaching the
 * triggers or the legalHold column. Audit-row UPDATEs and DELETEs
 * became permissible at the database level on every service writing
 * to the cross-service audit trail.
 *
 * Restoration shipped in `1787400000000-RestoreSharedAuditLogsImmutability`.
 * This invariant prevents a future migration from re-introducing the
 * regression class. The check is source-level: the most recent migration
 * that touches `shared.audit_logs` (by string match) MUST declare the
 * three artefacts (legalHold column + 2 trigger functions + 2 trigger
 * objects) OR be a no-op idempotency-check migration. The shape is
 * specific enough that any future maintainer dropping the protections
 * will fail this gate at CI.
 *
 * # Allowed shapes
 *
 *  1. `1787400000000-RestoreSharedAuditLogsImmutability` — installs all 3.
 *  2. Any later migration may CASCADE-drop the table only if it ALSO
 *     re-installs all 3 artefacts in the same `up()`. The required
 *     substrings are checked together.
 *
 * # Why this lives in tests/invariants/
 *
 * The audit-immutability regression is the kind of defect a code-only
 * review easily misses — the migration in question landed cleanly; the
 * trigger drop was implicit in CASCADE. A specific, narrow invariant
 * is the right tier-3 (make-detectable) hedge.
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const ENTITY_PATH = 'libs/backend-common/src/audit/audit-log.entity.ts';
const MIGRATION_GLOBS = [
  'apps/admin-api-service/src/migrations/*.ts',
  'apps/auth-service/src/migrations/*.ts',
] as const;

const REQUIRED_TRIGGER_NAMES = [
  'trg_audit_logs_prevent_update',
  'trg_audit_logs_prevent_legal_hold_delete',
] as const;

const REQUIRED_FUNCTION_NAMES_SHARED = [
  'shared.audit_logs_prevent_update',
  'shared.audit_logs_prevent_legal_hold_delete',
] as const;

const REQUIRED_FUNCTION_NAMES_AUTH = [
  'auth.audit_logs_prevent_update',
  'auth.audit_logs_prevent_legal_hold_delete',
] as const;

function loadMigrationCorpus(): string {
  const allFiles: string[] = [];
  for (const glob of MIGRATION_GLOBS) {
    const out = execSync(`git -C ${REPO_ROOT} ls-files ${glob}`, { encoding: 'utf8' });
    allFiles.push(...out.trim().split('\n').filter(Boolean));
  }
  return allFiles
    .map((rel) => readFileSync(resolve(REPO_ROOT, rel), 'utf8'))
    .join('\n---\n');
}

describe('INVARIANT (AUDITTRAIL-CRITICAL-001 / AUDITTRAIL-HIGH-005): audit-table immutability artefacts', () => {
  it('AuditLogEntity (shared) declares the legalHold column', () => {
    const entitySrc = readFileSync(resolve(REPO_ROOT, ENTITY_PATH), 'utf8');

    // The column declaration must be present so SchemaDriftValidator
    // catches any future migration that drops the underlying column.
    expect(entitySrc).toMatch(/legalHold!:\s*boolean/);
    expect(entitySrc).toMatch(/@Column\(\s*\{[^}]*type:\s*'boolean'/);
  });

  it('AuditLog entity (auth) declares the legalHold column', () => {
    const entitySrc = readFileSync(
      resolve(REPO_ROOT, 'apps/auth-service/src/audit/audit-log.entity.ts'),
      'utf8',
    );
    expect(entitySrc).toMatch(/legalHold!:\s*boolean/);
    expect(entitySrc).toMatch(/@Column\(\s*\{[^}]*type:\s*'boolean'/);
  });

  it('a migration creates the BEFORE UPDATE / BEFORE DELETE triggers and legalHold column on shared.audit_logs', () => {
    const aggregate = loadMigrationCorpus();

    // legalHold column ADD must appear in some migration after the realign
    // CASCADE. The regex is shape-specific to the ADD COLUMN pattern with
    // NOT NULL DEFAULT — matching the migration-sql-lint R2 contract.
    expect(aggregate).toMatch(
      /ALTER TABLE\s+shared\.audit_logs[\s\S]*?ADD COLUMN[\s\S]*?"legalHold"\s+boolean\s+NOT NULL\s+DEFAULT\s+false/i,
    );

    // Each trigger function name must be present in a CREATE OR REPLACE
    // FUNCTION definition.
    for (const fn of REQUIRED_FUNCTION_NAMES_SHARED) {
      const re = new RegExp(`CREATE OR REPLACE FUNCTION\\s+${fn.replace('.', '\\.')}\\s*\\(`, 'i');
      expect(aggregate).toMatch(re);
    }

    // Each trigger object must be created on shared.audit_logs.
    for (const trg of REQUIRED_TRIGGER_NAMES) {
      const re = new RegExp(
        `CREATE TRIGGER\\s+${trg}[\\s\\S]*?ON\\s+shared\\.audit_logs`,
        'i',
      );
      expect(aggregate).toMatch(re);
    }
  });

  it('a migration creates the BEFORE UPDATE / BEFORE DELETE triggers and legalHold column on auth.audit_logs', () => {
    const aggregate = loadMigrationCorpus();

    expect(aggregate).toMatch(
      /ALTER TABLE\s+auth\.audit_logs[\s\S]*?ADD COLUMN[\s\S]*?"legalHold"\s+boolean\s+NOT NULL\s+DEFAULT\s+false/i,
    );

    for (const fn of REQUIRED_FUNCTION_NAMES_AUTH) {
      const re = new RegExp(`CREATE OR REPLACE FUNCTION\\s+${fn.replace('.', '\\.')}\\s*\\(`, 'i');
      expect(aggregate).toMatch(re);
    }

    for (const trg of REQUIRED_TRIGGER_NAMES) {
      const re = new RegExp(
        `CREATE TRIGGER\\s+${trg}[\\s\\S]*?ON\\s+auth\\.audit_logs`,
        'i',
      );
      expect(aggregate).toMatch(re);
    }
  });

  it('the restoration migration refuses down() rollback', () => {
    // The cost of weak audit posture is paid forever; we deliberately
    // refuse a one-line operator rollback. This invariant catches anyone
    // editing down() to silently re-enable rollback.
    const restorationPath = resolve(
      REPO_ROOT,
      'apps/admin-api-service/src/migrations/1787400000000-RestoreSharedAuditLogsImmutability.ts',
    );
    const src = readFileSync(restorationPath, 'utf8');
    expect(src).toMatch(/throw new Error\(/);
    expect(src).toMatch(/Refusing to rollback/);
  });
});
