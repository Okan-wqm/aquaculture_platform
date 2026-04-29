/**
 * Platform-wide invariant — COMPLIANCE-HIGH-001:
 *
 * Every audit-log retention cleanup path MUST filter out `legalHold = true`
 * rows in the WHERE clause. The BEFORE DELETE trigger
 * `trg_*_audit_logs_prevent_legal_hold_delete` is defense-in-depth, not the
 * primary filter. A retention cron that omits the legalHold WHERE clause
 * issues a single statement-level DELETE — if ANY held row matches the
 * cutoff, the trigger raises an exception and aborts the ENTIRE batch.
 * The held row is preserved (good), but every co-matching un-held row is
 * rolled back too (BAD — retention drift accumulates silently).
 *
 * # Why
 *
 * Pre-fix `apps/auth-service/src/audit/audit-log.service.ts:159` and
 * `apps/farm-service/src/database/services/audit-log.service.ts:300`
 * issued `repository.delete({ createdAt: LessThan(cutoff) })` with no
 * legalHold filter. A single legally-held row in the matching set would
 * abort the whole cleanup cycle, leaving thousands of un-held expired
 * rows in place — both an integrity risk (uncontrolled growth) and a
 * compliance flag (retention SLA missed).
 *
 * Cured by switching to QueryBuilder `.where('"createdAt" < :cutoff')
 * .andWhere('"legalHold" = false')`.
 *
 * # What this invariant checks
 *
 * Source-text grep over every file matching '*audit-log*.service.ts' (or
 * the legacy '*audit-log.entity*service.ts' shape). For each file that
 * contains a DELETE-shape (deleteOldLogs / cleanupOldLogs / similar), the
 * WHERE clause MUST mention 'legalHold' (case-sensitive — the column is
 * camelCase). If no DELETE shape is found, the file is skipped.
 *
 * # Why this lives in tests/invariants/
 *
 * The defect class is "forgot to add WHERE filter" — easy to overlook in
 * code review (the trigger appears to handle it). A specific source-text
 * invariant is the right Tier-3 (make-detectable) hedge.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

function listAuditLogServiceFiles(): string[] {
  const out = execFileSync(
    'git',
    [
      '-C',
      REPO_ROOT,
      'ls-files',
      'apps/*/src/**/audit-log.service.ts',
      'apps/*/src/audit/audit-log.service.ts',
      'libs/*/src/**/audit-log.service.ts',
    ],
    { encoding: 'utf8' },
  );
  return out.trim().split('\n').filter(Boolean);
}

function hasDeleteShape(src: string): boolean {
  // Recognise typical retention-cleanup DELETE shapes — both
  // repository.delete({...}) and QueryBuilder .delete().execute().
  // The shape is what matters; we don't enforce a specific implementation.
  return (
    /(deleteOldLogs|cleanupOldLogs|cleanupOldAuditLogs)\s*\(/.test(src) ||
    /\.delete\(\)\s*\.where/.test(src) ||
    /repository\.delete\s*\(/.test(src)
  );
}

function hasLegalHoldFilter(src: string): boolean {
  // Either the QueryBuilder andWhere shape OR a literal SQL fragment
  // referencing the column. Both are valid as long as the filter is
  // present in the same file as the delete shape.
  return (
    /andWhere\s*\(\s*['"`]"?legalHold"?\s*=\s*false/.test(src) ||
    /WHERE[^;]*legalHold/i.test(src) ||
    /"legalHold"\s*=\s*false/.test(src)
  );
}

describe('INVARIANT (COMPLIANCE-HIGH-001): audit-log retention paths filter legalHold', () => {
  const files = listAuditLogServiceFiles();

  it('discovers at least one audit-log service file', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('audit-log service %s either has no DELETE shape OR filters legalHold', (rel) => {
    const src = readFileSync(resolve(REPO_ROOT, rel), 'utf8');

    if (!hasDeleteShape(src)) {
      // Not a retention path — read-only / append-only audit service.
      return;
    }

    expect(hasLegalHoldFilter(src)).toBe(true);
  });
});
