import { readdirSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';

import {
  ADMIN_AUDIT_ACTIONS,
  ADMIN_AUDIT_HTTP_ROUTES,
  ADMIN_AUDIT_TRUST_CLASS,
  ADMIN_AUDIT_WRITE_POLICY,
  adminAuditActionsForPolicy,
} from '@platform/admin-http-contracts';

const REPO_ROOT = resolve(__dirname, '..', '..');
const ADMIN_SOURCE = resolve(REPO_ROOT, 'apps/admin-api-service/src');

function runtimeSourcesBelow(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const absolute = resolve(directory, entry);
    if (statSync(absolute).isDirectory()) {
      if (['migrations', '__tests__', 'generated'].includes(entry)) return [];
      return runtimeSourcesBelow(absolute);
    }
    if (!/\.ts$/u.test(entry) || /\.(?:spec|test)\.ts$/u.test(entry)) return [];
    return [absolute];
  });
}

const runtimeSources = runtimeSourcesBelow(ADMIN_SOURCE);

function matchingRuntimeFiles(pattern: RegExp): string[] {
  return runtimeSources
    .filter((file) => pattern.test(readFileSync(file, 'utf8')))
    .map((file) => relative(REPO_ROOT, file))
    .sort();
}

describe('admin audit mutation authority', () => {
  it('has one typed action/policy/severity catalogue with all three policy classes inhabited', () => {
    expect(new Set(ADMIN_AUDIT_ACTIONS).size).toBe(ADMIN_AUDIT_ACTIONS.length);
    for (const policy of Object.values(ADMIN_AUDIT_WRITE_POLICY)) {
      expect(adminAuditActionsForPolicy(policy).length).toBeGreaterThan(0);
    }
  });

  it('admits no best-effort or raw audit writer outside the optional telemetry boundary', () => {
    expect(
      matchingRuntimeFiles(/auditLogService\.(?:log|recordAwait|recordAwaitInTransaction)\s*\(/u),
    ).toEqual([]);
    expect(matchingRuntimeFiles(/INSERT\s+INTO\s+(?:"admin"\.)?audit_logs/iu)).toEqual([]);
    expect(matchingRuntimeFiles(/\.appendOptionalTelemetry\s*\(/u)).toEqual([]);

    const service = readFileSync(resolve(ADMIN_SOURCE, 'audit/audit.service.ts'), 'utf8');
    expect(service).toContain('ADMIN_AUDIT_APPEND_SQL');
    expect(service).not.toMatch(/\.save\s*\(/u);
  });

  it('limits mandatory transaction and disclosure calls to governed boundaries', () => {
    expect(matchingRuntimeFiles(/\.appendInTransaction\s*\(/u)).toEqual([
      'apps/admin-api-service/src/database-management/controllers/explorer.controller.ts',
      'apps/admin-api-service/src/impersonation/services/impersonation.service.ts',
      'apps/admin-api-service/src/tenant/handlers/tenant-erasure.handler.ts',
    ]);
    expect(matchingRuntimeFiles(/\.appendBeforeDisclosure\s*\(/u)).toEqual([
      'apps/admin-api-service/src/audit/audit.controller.ts',
      'apps/admin-api-service/src/database-management/controllers/explorer.controller.ts',
    ]);
  });

  it('exposes exactly one immutable audit API and UI projection', () => {
    const generatedRoutes = readFileSync(
      resolve(ADMIN_SOURCE, 'bootstrap/generated/admin-request-contracts.generated.ts'),
      'utf8',
    );
    const actualRoutes = [
      ...new Set(
        generatedRoutes.match(/(?:GET|POST|PUT|PATCH|DELETE) \/audit-logs(?:[^"']*)/gu) ?? [],
      ),
    ].sort();
    expect(actualRoutes).toEqual(Object.values(ADMIN_AUDIT_HTTP_ROUTES).sort());
    expect(generatedRoutes).not.toMatch(/\/(?:security\/activities|security\/audit)(?:\/|["'])/u);

    const routeCatalog = readFileSync(
      resolve(REPO_ROOT, 'web/shared-ui/src/authz/admin-routes.ts'),
      'utf8',
    );
    expect(routeCatalog).toContain("id: 'admin-audit'");
    expect(routeCatalog).not.toMatch(/security-(?:activity|audit)/u);
  });

  it('keeps legacy rows searchable but structurally outside qualified completeness', () => {
    expect(Object.values(ADMIN_AUDIT_TRUST_CLASS)).toEqual([
      'AUTHORITATIVE_RUNTIME',
      'LEGACY_UNVERIFIED',
    ]);
    expect(matchingRuntimeFiles(/@Entity\(['"]activity_logs['"]/u)).toEqual([]);
    expect(matchingRuntimeFiles(/class (?:ActivityLoggingService|AuditTrailService)/u)).toEqual([]);
    expect(matchingRuntimeFiles(/DROP TABLE admin\.(?:activity_logs|retention_policies)/u)).toEqual(
      [],
    );

    const statistics = readFileSync(resolve(ADMIN_SOURCE, 'audit/audit.service.ts'), 'utf8');
    expect(statistics).toContain('WITH observed AS MATERIALIZED');
    expect(statistics).toContain(`WHERE "trustClass" = 'AUTHORITATIVE_RUNTIME'`);

    const consolidation = readFileSync(
      resolve(ADMIN_SOURCE, 'migrations/1808900000000-ConsolidateAdminActivityAuthority.ts'),
      'utf8',
    );
    expect(consolidation).toContain("'LEGACY_UNVERIFIED'");
    expect(consolidation).toContain("'sourceRowSha256'");
    expect(consolidation).toContain('public.digest');
    expect(consolidation.indexOf('FROM admin.activity_logs activity')).toBeLessThan(
      consolidation.indexOf('DROP TABLE admin.activity_logs'),
    );

    const trustMigration = readFileSync(
      resolve(ADMIN_SOURCE, 'migrations/1808750000000-EstablishAdminAuditTrustClasses.ts'),
      'utf8',
    );
    expect(trustMigration).toContain("'sourceAuthority', 'admin.audit_logs.pretrust'");
    expect(trustMigration).toContain("'sourceRowId', audit.id::text");
    expect(trustMigration).toContain("'sourceAction', audit.action");
    expect(trustMigration.indexOf('admin.audit_logs.pretrust')).toBeLessThan(
      trustMigration.indexOf('SET DEFAULT'),
    );
    expect(trustMigration).toContain('EXCEPTION WHEN OTHERS');
    expect(trustMigration).toContain(') IS TRUE)');
  });

  it('gives append and delete to distinct database authorities with no runtime retention API', () => {
    expect(
      matchingRuntimeFiles(/purgeOldLogs|admin\.audit_logs\.7y|shared\.audit_logs\.7y/u),
    ).toEqual([]);

    const databaseAuthority = readFileSync(
      resolve(ADMIN_SOURCE, 'audit/audit-database-authority.ts'),
      'utf8',
    );
    expect(databaseAuthority).toContain("appendFunction: 'admin.append_authoritative_audit_v1'");
    expect(databaseAuthority).toContain(
      "retentionControllerRole: 'admin_audit_retention_controller'",
    );

    const sealingMigration = readFileSync(
      resolve(ADMIN_SOURCE, 'migrations/1808900000000-ConsolidateAdminActivityAuthority.ts'),
      'utf8',
    );
    expect(sealingMigration).toContain('SECURITY DEFINER');
    expect(sealingMigration).toContain('trg_audit_logs_require_append_authority');
    expect(sealingMigration).toContain('current_user IS DISTINCT FROM');
    expect(sealingMigration).toContain(`NEW."trustClass" IS DISTINCT FROM 'AUTHORITATIVE_RUNTIME'`);
    expect(sealingMigration).toContain('REVOKE INSERT, UPDATE, DELETE ON admin.audit_logs');
    expect(sealingMigration).toContain('AUDIT_DELETE_AUTHORITY.DEDICATED_RETENTION_CONTROLLER');
  });

  it('projects tenant activity from owner evidence and has no runtime duplicate ledger', () => {
    expect(
      matchingRuntimeFiles(
        /@Entity\(['"]tenant_activities['"]|\bclass\s+TenantActivity\b|(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+admin\.tenant_activities/iu,
      ),
    ).toEqual([]);
    const projection = readFileSync(
      resolve(ADMIN_SOURCE, 'tenant/services/tenant-activity.service.ts'),
      'utf8',
    );
    expect(projection).toContain('auth.tenant_command_receipts');
    expect(projection).toContain("audit.action = 'LEGACY_TENANT_ACTIVITY_IMPORTED'");
  });

  it('seals lifecycle and erasure evidence at their source-owner transactions', () => {
    const authOwner = readFileSync(
      resolve(
        REPO_ROOT,
        'apps/auth-service/src/modules/tenant/services/tenant-provisioning-command.service.ts',
      ),
      'utf8',
    );
    expect(authOwner).toContain("createBaseEvent<TenantStatusChangedEvent>('TenantStatusChanged'");
    expect(authOwner).toContain('userId: command.actor.id');
    expect(authOwner).toContain('this.outboxPublisher.enqueue(');
    expect(authOwner).toContain('manager,');

    const receiptSeal = readFileSync(
      resolve(
        REPO_ROOT,
        'apps/auth-service/src/migrations/1808500000000-SealTenantCommandReceiptEvidence.ts',
      ),
      'utf8',
    );
    expect(receiptSeal).toContain("IF OLD.status = 'SUCCEEDED'");
    expect(receiptSeal).toContain('BEFORE UPDATE OR DELETE ON auth.tenant_command_receipts');

    const activityRetirement = readFileSync(
      resolve(ADMIN_SOURCE, 'migrations/1808800000000-ConsolidateTenantActivityAuthority.ts'),
      'utf8',
    );
    expect(activityRetirement.indexOf('INSERT INTO admin.audit_logs')).toBeLessThan(
      activityRetirement.indexOf('DROP TABLE admin.tenant_activities'),
    );
  });
});
