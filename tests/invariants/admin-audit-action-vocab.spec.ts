/**
 * APA-224 — admin audit-action filter vocabulary parity (RC-5).
 *
 * The audit action vocabulary is the backend `AuditAction` enum
 * (apps/admin-api-service/src/audit/audit.entity.ts), stored UPPERCASE_SNAKE in
 * admin.audit_logs. The AuditTrailPage filter dropdown previously offered
 * generic lowercase verbs (create/read/update/delete/login/logout) that never
 * matched a stored row, so every filtered audit query returned 0 rows — false
 * assurance on a SUPER_ADMIN compliance surface. The query DTOs now
 * `@IsEnum(AuditAction)` the action (out-of-vocab → 400), and the dropdown
 * offers real values.
 *
 * This gate binds the FE dropdown to the backend enum: every value the filter
 * offers must be a real AuditAction member, and the dead lowercase verbs must
 * not reappear.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const read = (rel: string): string => readFileSync(resolve(REPO_ROOT, rel), 'utf-8');

const AUDIT_ENTITY = 'apps/admin-api-service/src/audit/audit.entity.ts';
const FE_PAGE = 'web/modules/admin-panel/src/pages/security/AuditTrailPage.tsx';

function backendAuditActions(): Set<string> {
  const src = read(AUDIT_ENTITY);
  const block = /export enum AuditAction\s*\{([\s\S]*?)\}/.exec(src);
  if (block === null) throw new Error('AuditAction enum not found');
  return new Set([...(block[1] ?? '').matchAll(/=\s*'([^']+)'/g)].map((m) => m[1] ?? ''));
}

function feFilterActionValues(): string[] {
  const src = read(FE_PAGE);
  const block = /AUDIT_ACTION_FILTER_OPTIONS[\s\S]*?=\s*\[([\s\S]*?)\];/.exec(src);
  if (block === null) throw new Error('AUDIT_ACTION_FILTER_OPTIONS not found in AuditTrailPage');
  return [...(block[1] ?? '').matchAll(/value:\s*'([^']+)'/g)].map((m) => m[1] ?? '');
}

describe('admin audit-action vocabulary parity (APA-224)', () => {
  const backend = backendAuditActions();

  it('every filter-dropdown action is a real backend AuditAction value', () => {
    const values = feFilterActionValues();
    expect(values.length).toBeGreaterThan(0);
    const bogus = values.filter((v) => !backend.has(v));
    expect(bogus).toEqual([]);
  });

  it('the dead lowercase verbs are gone from the filter dropdown', () => {
    const values = feFilterActionValues();
    for (const dead of ['create', 'read', 'update', 'delete', 'login', 'logout']) {
      expect(values).not.toContain(dead);
    }
  });
});
