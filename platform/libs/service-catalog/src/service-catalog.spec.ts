import {
  PLATFORM_SERVICE_CATALOG,
  activeDropletComposeServices,
  gatewaySubgraphs,
  imageBuildTargets,
  packageBuildProjects,
  requiredRuntimeEnv,
  requiredRuntimeSecrets,
  schemaOwningServices,
  validateServiceCatalog,
} from './index';

describe('platform service catalog executable views', () => {
  it('validates catalog structure and role ownership', () => {
    expect(validateServiceCatalog()).toEqual([]);
  });

  it('keeps event-store outside active deploy/build paths and gateway composition', () => {
    expect(activeDropletComposeServices()).not.toContain('event-store-service');
    expect(imageBuildTargets()).not.toContain('event-store-service');
    expect(packageBuildProjects()).not.toContain('event-store-service');
    expect(gatewaySubgraphs().map((entry) => entry.name)).not.toContain('event_store');
    expect(gatewaySubgraphs().map((entry) => entry.nxProject)).not.toContain('event-store-service');
  });

  it('models config-service visibility separately from Apollo participation', () => {
    const configService = PLATFORM_SERVICE_CATALOG.find(
      (entry) => entry.serviceId === 'config-service',
    );

    expect(configService?.serviceVisibility).toBe('internal');
    expect(configService?.gatewayParticipation).toBe('apollo-subgraph');
    expect(gatewaySubgraphs().map((entry) => entry.name)).toContain('config');
  });

  it('separates operator-provided runtime env from secret material', () => {
    expect(requiredRuntimeEnv()).not.toContain('SERVICE_IDENTITY_KEYRING');
    expect(requiredRuntimeEnv()).not.toContain('EVENT_STORE_SERVICE_DB_PASS');
    expect(requiredRuntimeSecrets()).toContain('EVENT_STORE_SERVICE_DB_PASS');
    expect(requiredRuntimeSecrets()).toContain('SERVICE_IDENTITY_KEYRING');
    expect(requiredRuntimeSecrets()).toContain('CONFIG_SERVICE_DB_PASS');
  });

  it('declares one migration authority for every schema-owning runtime service', () => {
    for (const entry of schemaOwningServices()) {
      expect(entry.dbRoles?.owner).toMatch(/_schema_owner$/);
      expect(entry.dbRoles?.migrator).toBe('db_migrate');
      expect(entry.dbRoles?.runtime).toMatch(/_service$/);
      expect(entry.privilegeMode).toBe('dml-only');
    }
  });
});
