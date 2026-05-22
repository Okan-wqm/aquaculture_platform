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
    expect(httpClient).toContain("tenantScope === 'platform' ? null : getTenantId()");
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
