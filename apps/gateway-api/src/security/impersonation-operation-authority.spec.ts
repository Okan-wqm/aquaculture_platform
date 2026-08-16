import { ForbiddenException } from '@nestjs/common';
import {
  IMPERSONATION_MODULES,
  type ImpersonationPermissionsContract,
} from '@aquaculture/shared-contracts';

import { FEDERATED_SUBGRAPHS } from '../config/federated-subgraphs.generated';

import {
  assertImpersonationGraphqlEnvelope,
  enforceImpersonationOperations,
  resolveGraphqlImpersonationOperations,
  resolveRestImpersonationOperation,
} from './impersonation-operation-authority';

const permissions = (
  overrides: Partial<ImpersonationPermissionsContract> = {},
): ImpersonationPermissionsContract => ({
  canViewData: false,
  canModifyData: false,
  canAccessSettings: false,
  canManageUsers: false,
  canViewBilling: false,
  canExportData: false,
  ...overrides,
});

describe('canonical impersonation operation authority', () => {
  it('keeps the canonical module vocabulary identical to the live subgraph registry', () => {
    expect([...IMPERSONATION_MODULES].sort()).toEqual(
      FEDERATED_SUBGRAPHS.map((subgraph) => subgraph.name).sort(),
    );
  });

  it('maps billing reads to canViewBilling rather than generic data access', () => {
    const operations = resolveGraphqlImpersonationOperations({
      query: 'query TenantBilling { tenantBilling { id } }',
      module: 'billing',
    });
    expect(operations).toEqual([
      { authority: 'billing.read', module: 'billing', operation: 'Query.tenantBilling' },
    ]);
    expect(() =>
      enforceImpersonationOperations(permissions({ canViewBilling: true }), operations),
    ).not.toThrow();
    expect(() =>
      enforceImpersonationOperations(permissions({ canViewData: true }), operations),
    ).toThrow(ForbiddenException);
  });

  it('requires specialized grant plus write mode for user and settings writes', () => {
    const userWrite = resolveGraphqlImpersonationOperations({
      query: 'mutation CreateTenantUser { createTenantUser(input: {}) { id } }',
      module: 'auth',
    });
    expect(userWrite[0]?.authority).toBe('users.write');
    expect(() =>
      enforceImpersonationOperations(permissions({ canManageUsers: true }), userWrite),
    ).toThrow(ForbiddenException);
    expect(() =>
      enforceImpersonationOperations(
        permissions({ canManageUsers: true, canModifyData: true }),
        userWrite,
      ),
    ).not.toThrow();

    const settingsWrite = resolveGraphqlImpersonationOperations({
      query: 'mutation SetConfiguration { setConfiguration(input: {}) { key } }',
      module: 'config',
    });
    expect(settingsWrite[0]?.authority).toBe('settings.write');
    expect(() =>
      enforceImpersonationOperations(
        permissions({ canAccessSettings: true, canModifyData: true }),
        settingsWrite,
      ),
    ).not.toThrow();

    const sensorConfigurationWrite = resolveGraphqlImpersonationOperations({
      query: 'mutation PushIoConfig { pushIoConfigToDevice(deviceId: "device") { success } }',
      module: 'sensor',
    });
    expect(sensorConfigurationWrite[0]?.authority).toBe('settings.write');
  });

  it('uses exact export root fields, not caller-controlled operation labels', () => {
    const exactExport = resolveGraphqlImpersonationOperations({
      query: 'mutation Anything { exportTenantData { downloadUrl } }',
      module: 'farm',
    });
    expect(exactExport[0]?.authority).toBe('export');

    expect(() =>
      resolveGraphqlImpersonationOperations({
        query: 'mutation ExportTenantData { unknownWrite(input: {}) { id } }',
        module: 'farm',
      }),
    ).toThrow(ForbiddenException);
  });

  it('collects fragment root fields and requires every mapped grant', () => {
    const operations = resolveGraphqlImpersonationOperations({
      query: `
        query Combined {
          ...BillingFields
          invoices { id }
        }
        fragment BillingFields on Query { tenantBilling { id } }
      `,
      module: 'billing',
    });
    expect(operations.map((operation) => operation.operation).sort()).toEqual([
      'Query.invoices',
      'Query.tenantBilling',
    ]);
    expect(() =>
      enforceImpersonationOperations(permissions({ canViewBilling: true }), operations),
    ).not.toThrow();
  });

  it('enforces exact module allow and deny lists with deny precedence', () => {
    const farmRead = resolveGraphqlImpersonationOperations({
      query: 'query Batches { batches { id } }',
      module: 'farm',
    });
    expect(() =>
      enforceImpersonationOperations(
        permissions({ canViewData: true, allowedModules: ['sensor'] }),
        farmRead,
      ),
    ).toThrow(ForbiddenException);
    expect(() =>
      enforceImpersonationOperations(
        permissions({
          canViewData: true,
          allowedModules: ['farm'],
          restrictedModules: ['farm'],
        }),
        farmRead,
      ),
    ).toThrow(ForbiddenException);
    expect(() =>
      enforceImpersonationOperations(
        permissions({ canViewData: true, allowedModules: ['farm'] }),
        farmRead,
      ),
    ).not.toThrow();
  });

  it('maps the exact sensor export REST template to canExportData', () => {
    const operation = resolveRestImpersonationOperation({
      serviceName: 'sensor-service',
      method: 'GET',
      path: '/api/sensors/11111111-1111-4111-8111-111111111111/export',
    });
    expect(operation).toMatchObject({ authority: 'export', module: 'sensor' });
    expect(() =>
      enforceImpersonationOperations(permissions({ canExportData: true }), [operation]),
    ).not.toThrow();
  });

  it('fails closed for ambiguous documents and unknown modules/services', () => {
    expect(() =>
      resolveGraphqlImpersonationOperations({
        query: 'query A { batches { id } } query B { tanks { id } }',
        module: 'farm',
      }),
    ).toThrow(ForbiddenException);
    expect(() =>
      resolveGraphqlImpersonationOperations({ query: 'query A { batches { id } }', module: 'Farm' }),
    ).toThrow(ForbiddenException);
    expect(() =>
      resolveRestImpersonationOperation({ serviceName: 'admin-api-service', method: 'GET', path: '/' }),
    ).toThrow(ForbiddenException);
    expect(() =>
      resolveGraphqlImpersonationOperations({
        query: 'query A { ...Missing }',
        module: 'ai',
      }),
    ).toThrow(ForbiddenException);
  });

  it('rejects local, incremental, streaming, and open-ended GraphQL envelopes', () => {
    expect(() =>
      assertImpersonationGraphqlEnvelope({ query: 'query Schema { __schema { types { name } } }' }),
    ).toThrow(ForbiddenException);
    expect(() =>
      assertImpersonationGraphqlEnvelope({
        query: 'subscription Readings { sensorReadingAdded { id } }',
      }),
    ).toThrow(ForbiddenException);
    expect(() =>
      assertImpersonationGraphqlEnvelope({
        query: 'query Farms { farms @stream(initialCount: 1) { id } }',
      }),
    ).toThrow(ForbiddenException);
    expect(() =>
      assertImpersonationGraphqlEnvelope({
        query: 'query Farms { farms { id } }',
        extensions: { persistedQuery: { sha256Hash: 'caller-controlled' } },
      }),
    ).toThrow(ForbiddenException);
  });
});
