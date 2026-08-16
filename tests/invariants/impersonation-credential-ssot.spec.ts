import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { IMPERSONATION_CREDENTIAL_HEADER } from '../../libs/shared-contracts/src/http/impersonation-policy';

const ROOT = resolve(__dirname, '..', '..');
const read = (path: string): string => readFileSync(resolve(ROOT, path), 'utf8');

describe('canonical impersonation credential authority', () => {
  it('pins the compiler-required controller literal to the shared transport name', () => {
    const controller = read(
      'apps/admin-api-service/src/impersonation/controllers/impersonation.controller.ts',
    );
    const header = controller.match(/@Headers\('([^']+)'\) token: string/)?.[1];
    expect(header).toBe(IMPERSONATION_CREDENTIAL_HEADER);
  });

  it('requires signed context resolution plus an exact committed operation receipt', () => {
    const middleware = read('apps/gateway-api/src/middleware/effective-tenant.middleware.ts');
    expect(middleware).toContain('IMPERSONATION_CREDENTIAL_HEADER');
    expect(middleware).toContain(
      'Cross-tenant access requires a canonical impersonation credential',
    );
    expect(middleware).toContain('this.impersonationAuthorization.resolveContext');
    expect(middleware).toContain('this.impersonationAuthorization.authorizeOperations');
    expect(middleware).toContain('impersonationAuthorizationReceiptsCommitted');
    expect(middleware).toContain("Reflect.deleteProperty(r, 'requestedImpersonationToken')");
    expect(middleware).toContain('grant.superAdminId !== user.sub');
    expect(middleware).toContain('grant.targetTenantId !== requested');

    const isolation = read('apps/gateway-api/src/guards/tenant-isolation.guard.ts');
    expect(isolation).not.toContain("request.headers['x-tenant-id']");
    expect(isolation).toContain('request.effectiveTenantId ?? user.tenantId');

    const downstreamGuard = read('libs/backend-common/src/guards/tenant.guard.ts');
    expect(downstreamGuard).toContain(
      'Raw act-as tenant headers cannot authorize cross-tenant access',
    );
    expect(downstreamGuard).toContain(
      'Cross-tenant access requires a canonical verified impersonation assertion',
    );
  });

  it('uses one closed operation-to-grant and module authority', () => {
    const policy = read('libs/shared-contracts/src/http/impersonation-policy.ts');
    const operationAuthority = read(
      'apps/gateway-api/src/security/impersonation-operation-authority.ts',
    );
    const generatedPolicy = read(
      'apps/gateway-api/src/security/generated/impersonation-graphql-operation-policy.generated.ts',
    );
    const policyGenerator = read('scripts/graphql/generate-impersonation-operation-policy.mjs');
    const routeCatalog = read(
      'apps/gateway-api/src/security/impersonation-route-consumer-catalog.ts',
    );
    for (const authority of [
      'data.read',
      'data.write',
      'billing.read',
      'billing.write',
      'users.read',
      'users.write',
      'settings.read',
      'settings.write',
      'export',
    ]) {
      expect(policy).toContain(`'${authority}'`);
    }
    expect(policy).toContain('IMPERSONATION_OPERATION_GRANT_MAP');
    expect(policy).toContain('IMPERSONATION_PERMISSION_FIELDS');
    expect(policy).toContain('restrictedModules always wins over allowedModules');
    expect(operationAuthority).toContain('IMPERSONATION_GRAPHQL_OPERATION_POLICY');
    expect(operationAuthority).toContain('resolveImpersonationRestOperationPolicy');
    expect(operationAuthority).toContain('evaluateImpersonationAuthorization');
    expect(generatedPolicy).toContain('IMPERSONATION_GRAPHQL_SCHEMA_DIGESTS');
    expect(policyGenerator).toContain('dist/graphql/subgraphs');
    expect(routeCatalog).toContain('GATEWAY_MARINE_IMPERSONATION_ROUTE');
    expect(routeCatalog).toContain('GATEWAY_SENSOR_EXPORT_IMPERSONATION_ROUTE');
  });

  it('binds session provenance into downstream assertions and both audit ledgers', () => {
    const assertion = read('libs/backend-common/src/http/gateway-verified-user-assertion.ts');
    const gatewayDataSource = read('apps/gateway-api/src/federation/authenticated-data-source.ts');
    const tenantGuard = read('libs/backend-common/src/guards/tenant.guard.ts');
    const adminLedger = read(
      'apps/admin-api-service/src/impersonation/services/impersonation.service.ts',
    );
    const adminAudit = read('apps/admin-api-service/src/audit/audit.service.ts');
    expect(assertion).toContain('impersonationSessionId');
    expect(assertion).toContain('impersonationPermissions');
    expect(gatewayDataSource).toContain('resolveGraphqlImpersonationOperations');
    expect(gatewayDataSource).toContain('impersonationSessionId: req.impersonationSessionId');
    expect(tenantGuard).toContain("resource: 'ImpersonationSession'");
    expect(tenantGuard).toContain('effectivePermissions');
    expect(adminLedger).toContain("'IMPERSONATION_OPERATIONS_AUTHORIZED'");
    expect(adminLedger).toContain('ImpersonationAuthorizationReceipt');
    expect(adminLedger).toContain('retire_impersonation_authorization_receipts');
    expect(adminLedger).toContain('this.dataSource.transaction');
    expect(adminLedger).toContain('this.auditLogService.recordAwaitInTransaction');
    expect(adminAudit).toContain('async recordAwait(input: AuditLogInput)');
    expect(adminAudit).toContain('async recordAwaitInTransaction(');
  });

  it('hands the raw token through an ephemeral fragment and memory-only client state', () => {
    const page = read('web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx');
    const client = read('web/shared-ui/src/utils/api-client.ts');
    expect(page).toContain('`/tenant#${fragment.toString()}`');
    expect(page).not.toContain('/tenant?impersonation_session=');
    expect(client).toContain('consumeImpersonationHandoffFragment');
    expect(client).toContain('headers[IMPERSONATION_CREDENTIAL_HEADER]');
    expect(client).not.toMatch(/localStorage\.(?:setItem|getItem)\([^\n]*impersonation/i);
  });

  it('strips the credential at unsigned service boundaries', () => {
    const strip = read('libs/backend-common/src/middleware/strip-internal-headers.middleware.ts');
    expect(strip).toContain('IMPERSONATION_CREDENTIAL_HEADER');
  });
});
