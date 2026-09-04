/**
 * Invariant: platform-admin security pages must consume the canonical
 * backend contracts and immutable audit source of truth.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

function readRepoFile(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf-8');
}

describe('INVARIANT: platform-admin security frontend uses backend envelopes', () => {
  it('keeps compliance reports paginated instead of requiring a raw array', () => {
    const securityApi = readRepoFile('web/modules/admin-panel/src/services/api/security.ts');
    const compliancePage = readRepoFile('web/modules/admin-panel/src/pages/security/CompliancePage.tsx');

    expect(securityApi).toContain('PaginatedResult<BackendComplianceReport>');
    expect(securityApi).toContain('/security/compliance/reports');
    expect(compliancePage).toContain('result.data.map(mapComplianceReport)');
    expect(compliancePage).not.toContain('Compliance reports: expected array');
    expect(compliancePage).not.toContain('apiParams.type = params.requestType');
  });

  it('runs platform-admin security API reads without implicit tenant header scope', () => {
    const httpClient = readRepoFile('web/modules/admin-panel/src/services/http-client.ts');
    const securityApi = readRepoFile('web/modules/admin-panel/src/services/api/security.ts');
    const securityTypes = readRepoFile('web/modules/admin-panel/src/services/types/security.ts');

    expect(httpClient).toContain("tenantScope?: 'tenant' | 'platform'");
    expect(httpClient).toContain("tenantScope = 'platform'");
    expect(httpClient).toContain('resolveTenantIdForScope');
    expect(httpClient).toContain('RESERVED_SECURITY_HEADERS');
    expect(httpClient).toContain('mergeHeadersWithReservedPolicy');
    expect(httpClient).toContain("'x-tenant-id'");
    expect(httpClient).toContain("'authorization'");
    expect(securityApi).toContain("const platformScope = { tenantScope: 'platform' as const }");
    expect(securityApi).not.toContain('isResolved');
    expect(securityApi).not.toContain('Not implemented');
    expect(securityApi).not.toContain('TODO');
    expect(securityTypes).not.toContain('isResolved');
    expect(securityTypes).not.toContain('export interface SecurityEvent');
    expect(securityTypes).not.toContain('export interface ComplianceReport');
    expect(securityTypes).not.toContain('export interface DataSubjectRequest');
    expect(securityApi).not.toContain('status: \'resolved\'');
  });
});

describe('INVARIANT: /security/audit reads immutable audit logs', () => {
  it('uses AuditLogService for list, summary, and entity history reads', () => {
    const controller = readRepoFile(
      'apps/admin-api-service/src/security/controllers/audit-trail.controller.ts',
    );

    expect(controller).toContain('AuditLogService');
    expect(controller).toContain('PaginatedAuditLogs');
    // …and `PaginatedAuditLogs` must BE the authority's page, not a
    // service-local near-copy of it. It used to be a hand-written interface
    // missing hasNextPage/hasPreviousPage, understating what its own producer
    // already returned; naming it still passes, so the name alone proves
    // nothing without this.
    expect(readRepoFile('apps/admin-api-service/src/audit/audit.service.ts')).toContain(
      'export type PaginatedAuditLogs = PaginationResultV1<AuditLog>;',
    );
    expect(controller).toContain('this.auditLogService.query(');
    expect(controller).toContain('this.auditLogService.getStatistics(');
    expect(controller).toContain('this.auditLogService.getEntityHistory(');
    expect(controller).toContain('AUDIT_LOG_ACCESSED');
    expect(controller).not.toContain('return this.auditService.getAuditTrail({');
    expect(controller).not.toContain('return this.auditService.getAuditSummary({');
  });

  it('keeps immutable admin.audit_logs append-only from runtime services', () => {
    const auditService = readRepoFile('apps/admin-api-service/src/audit/audit.service.ts');

    expect(auditService).toContain('Skipped immutable audit log purge request');
    expect(auditService).not.toContain('.delete()');
    expect(auditService).not.toContain('Purged ${result.affected} audit logs');
  });
});

describe('INVARIANT: security monitoring DTOs match entity enum contracts', () => {
  it('rejects stale frontend-only status and indicator aliases at the backend boundary', () => {
    const controller = readRepoFile(
      'apps/admin-api-service/src/security/controllers/security-monitoring.controller.ts',
    );

    expect(controller).toContain('SECURITY_EVENT_TYPES');
    expect(controller).toContain('SECURITY_EVENT_STATUSES');
    expect(controller).toContain('THREAT_INDICATOR_TYPES');
    expect(controller).not.toContain("'resolved'");
    expect(controller).not.toContain("'file_hash'");
    expect(controller).not.toContain("'authentication', 'authorization', 'data_access', 'system'");
  });
});

/**
 * The compliance surface must consume the shape the backend actually persists
 * and sends.
 *
 * `GET /security/compliance/checks/:framework` returns `ComplianceCheckResult[]`,
 * whose `requirement` is a nested `ComplianceRequirement` OBJECT. The panel's
 * hand-written response type declared it a string and invented `id`, `category`,
 * `description`, `lastChecked` and `nextReview` at the top level. `apiFetch<T>`'s
 * generic is an unchecked assertion across the wire, so tsc validated none of it.
 *
 * `mapComplianceCheck` then SPREAD the raw row, carrying the object into
 * `<p>{check.requirement}</p>` — React refuses to render an object as a child,
 * and admin-panel has no error boundary of its own, so the throw escapes to the
 * shell and blanks the page. The same drift, on the same shape, crashed the
 * Reports tab: `generateComplianceReport` stores those rows verbatim into the
 * `detailedFindings` jsonb column, and a monthly cron guarantees at least one
 * such report exists.
 *
 * Both cures are the same: name the real shape on both sides, and PROJECT
 * rather than spread, so an object cannot reach JSX by construction.
 *
 * @see docs/reviews/claude/2026-07-20-admin-panel-e2e-audit/findings/security.md
 * @see docs/reviews/orphan-findings.md#ADMIN-HIGH-006
 */
describe('INVARIANT (ADMIN-HIGH-006): compliance checks consume the canonical result', () => {
  /** Source with comments stripped — explaining a removed field must not re-introduce it. */
  const withoutComments = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('carries a real check timestamp instead of an invented review schedule', () => {
    const service = readRepoFile(
      'apps/admin-api-service/src/security/services/compliance.service.ts',
    );

    // `checkedAt` is the one field the UI legitimately needed that the contract
    // lacked. `nextReview` is NOT added: checks execute live per request and no
    // scheduled-review concept exists, so inventing one server-side to satisfy
    // a column would be fiction.
    expect(service).toContain('checkedAt: string');
    expect(withoutComments(service)).not.toContain('nextReview');
    expect(service).toContain('checkedAt: new Date().toISOString()');
    // The split is what stops a check from having to fake its own timestamp.
    expect(service).toContain('export interface ComplianceCheckOutcome');
    expect(service).toContain('Promise<ComplianceCheckOutcome>');
  });

  it('declares the nested requirement object on the frontend', () => {
    const types = readRepoFile('web/modules/admin-panel/src/services/types/security.ts');
    const api = readRepoFile('web/modules/admin-panel/src/services/api/security.ts');

    expect(types).toContain('export interface BackendComplianceRequirement');
    expect(types).toContain('export interface BackendComplianceCheckResult');
    expect(types).toContain('requirement: BackendComplianceRequirement');
    expect(api).toContain('apiFetch<BackendComplianceCheckResult[]>');
    // The invented flat fields, and the inline literal that hid them from tsc.
    expect(withoutComments(types)).not.toContain('nextReview');
    expect(api).not.toContain('lastChecked: string');
  });

  it('projects the check result instead of spreading it', () => {
    const page = readRepoFile('web/modules/admin-panel/src/pages/security/CompliancePage.tsx');
    const code = withoutComments(page);

    expect(code).toContain('result.requirement.requirement');
    expect(code).toContain('result.requirement.category');
    expect(code).toContain('lastChecked: result.checkedAt');
    // The spread is the defect itself.
    expect(code).not.toMatch(/\.\.\.check\b/);
    expect(code).not.toContain('nextReview');
  });

  it('reads report findings through the render-safety guard, like its sibling branch', () => {
    const page = readRepoFile('web/modules/admin-panel/src/pages/security/CompliancePage.tsx');
    const code = withoutComments(page);

    // The violations branch always applied toPrimitiveString; the
    // complianceResults branch did not, which is the whole of the Reports-tab
    // half of this finding.
    expect(code).toContain('toPrimitiveString(finding.requirement?.requirement');
    expect(code).toContain('toPrimitiveString(finding.details');
    expect(code).not.toContain('finding.category ??');
  });

  it('keeps no compat shim for a wrapper shape the route never returns', () => {
    const page = readRepoFile('web/modules/admin-panel/src/pages/security/CompliancePage.tsx');
    const code = withoutComments(page);

    // `runComplianceChecks` returns the array untransformed; the
    // `{ checks: [...] }` unwrap defended against a shape that has never
    // existed, and needed a cast to compile.
    expect(code).not.toContain("'checks' in result");
    expect(code).not.toContain('{ checks?: unknown }');
    // The is-array assertion stays: apiFetch's generic is an assertion, not a
    // check, so this is the first line that can notice a real drift.
    expect(code).toContain('Compliance checks: expected an array');
  });
});
