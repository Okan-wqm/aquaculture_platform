/**
 * APA-236 — data-subject-request status vocabulary parity (RC-5).
 *
 * The data-request status vocabulary has one source of truth: the backend
 * `DATA_REQUEST_STATUSES` array (apps/admin-api-service/src/security/entities/
 * security.entity.ts), backed by the admin.data_requests status CHECK
 * constraint and used by the query DTO's `@IsIn`. The admin-panel is a federated
 * remote that cannot import it, so it mirrors the array and drives the
 * CompliancePage status filter from that mirror.
 *
 * Before the fix the dropdown hand-listed `identity_verification` and
 * `processing` (states the backend never has) and omitted `expired`, so those
 * filters silently returned an empty list. This gate binds the two mirrors and
 * forbids the dropdown from regressing to hand-written option values.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const read = (rel: string): string => readFileSync(resolve(REPO_ROOT, rel), 'utf-8');

const BACKEND_ENTITY = 'apps/admin-api-service/src/security/entities/security.entity.ts';
const FE_TYPES = 'web/modules/admin-panel/src/services/types/security.ts';
const FE_PAGE = 'web/modules/admin-panel/src/pages/security/CompliancePage.tsx';

/** Extract the string literals of a `DATA_REQUEST_STATUSES = [...] as const` array. */
function statusArray(rel: string): string[] {
  const src = read(rel);
  const block = /DATA_REQUEST_STATUSES\s*=\s*\[([\s\S]*?)\]\s*as const/.exec(src);
  if (block === null) throw new Error(`DATA_REQUEST_STATUSES not found in ${rel}`);
  return [...(block[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '').sort();
}

describe('admin data-request-status vocabulary parity (APA-236)', () => {
  const backend = statusArray(BACKEND_ENTITY);

  it('sanity: the backend vocabulary is the expected five states', () => {
    expect(backend).toEqual(['completed', 'expired', 'in_progress', 'pending', 'rejected']);
  });

  it('the FE mirror equals the backend vocabulary', () => {
    expect(statusArray(FE_TYPES)).toEqual(backend);
  });

  it('CompliancePage drives the status filter from the SSoT, not hand-written options', () => {
    const page = read(FE_PAGE);
    expect(page).toContain('DATA_REQUEST_STATUSES.map');
    expect(page).not.toContain('value="identity_verification"');
    expect(page).not.toContain('value="processing"');
  });
});
