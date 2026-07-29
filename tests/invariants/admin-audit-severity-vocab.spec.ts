/**
 * APA-004 / APA-358 — admin audit-severity vocabulary parity (RC-5).
 *
 * The admin audit severity vocabulary has ONE source of truth: the backend
 * `AuditSeverity` enum (apps/admin-api-service/src/audit/audit.entity.ts),
 * enforced at the DB by admin.audit_logs_severity_enum. The admin-panel is a
 * federated remote that cannot import the backend enum, so its hand-written
 * severity type + filter drifted to `low|medium|high|critical` — values the
 * backend never emits — leaving real `info`/`warning` rows unstyled and three
 * of four filter options unmatchable.
 *
 * This gate binds the FE vocabulary to the backend SSoT by static text
 * analysis, so the drift cannot silently reappear: the FE `AuditLog.severity`
 * union must equal the backend enum values, and every severity the filter
 * dropdown offers must be a real backend value.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const read = (rel: string): string => readFileSync(resolve(REPO_ROOT, rel), 'utf-8');

const AUDIT_ENTITY = 'apps/admin-api-service/src/audit/audit.entity.ts';
const FE_AUDIT_TYPES = 'web/modules/admin-panel/src/services/types/audit.ts';
const FE_AUDIT_PAGE = 'web/modules/admin-panel/src/pages/AuditLogPage.tsx';

const uniqSorted = (values: string[]): string[] => [...new Set(values)].sort();

/** Backend SSoT: the string values of the `AuditSeverity` enum. */
function backendSeverities(): string[] {
  const src = read(AUDIT_ENTITY);
  const block = /export enum AuditSeverity\s*\{([^}]*)\}/.exec(src);
  if (block === null) throw new Error('AuditSeverity enum not found in audit.entity.ts');
  return uniqSorted([...(block[1] ?? '').matchAll(/=\s*'([^']+)'/g)].map((m) => m[1] ?? ''));
}

/** FE `AuditLog.severity` string-literal union. */
function feTypeSeverities(): string[] {
  const src = read(FE_AUDIT_TYPES);
  const line = /severity:\s*([^;]+);/.exec(src);
  if (line === null) throw new Error('severity field not found in FE audit types');
  return uniqSorted([...(line[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1] ?? ''));
}

/** Non-empty severity values offered by the AuditLogPage filter dropdown. */
function feFilterSeverities(): string[] {
  const src = read(FE_AUDIT_PAGE);
  const arr = /const SEVERITY_LEVELS\s*=\s*\[([\s\S]*?)\];/.exec(src);
  if (arr === null) throw new Error('SEVERITY_LEVELS not found in AuditLogPage');
  return uniqSorted(
    [...(arr[1] ?? '').matchAll(/value:\s*'([^']*)'/g)].map((m) => m[1] ?? '').filter((v) => v !== ''),
  );
}

describe('admin audit-severity vocabulary parity (APA-004/358)', () => {
  const backend = backendSeverities();

  it('sanity: the backend AuditSeverity enum is the expected three-value vocabulary', () => {
    expect(backend).toEqual(['critical', 'info', 'warning']);
  });

  it('derives the FE severity vocabulary instead of re-listing it', () => {
    // This compared two hand-written copies. There is one now: `AuditLog` (and
    // `AuditSeverity` with it) is generated from the backend entity and
    // `types/audit.ts` re-exports, so `admin-contracts-generated` owns the
    // agreement and the compiler owns the rest.
    const feTypes = readFileSync(
      resolve(REPO_ROOT, 'web/modules/admin-panel/src/services/types/audit.ts'),
      'utf-8',
    );
    expect(feTypes).toContain("from './generated/admin-contracts'");
    expect(feTypes).not.toMatch(/export interface AuditLog\s*\{/);
  });

  it('every severity the filter dropdown offers is a real backend value', () => {
    const bogus = feFilterSeverities().filter((v) => !backend.includes(v));
    expect(bogus).toEqual([]);
  });
});
