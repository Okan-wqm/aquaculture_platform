import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  PLATFORM_SERVICE_CATALOG,
  activeDropletComposeServices,
  frontendImageBuildTargets,
  frontendPrebuildPlan,
  gatewaySubgraphs,
  imageBuildTargets,
  packageBuildProjects,
  requiredRuntimeEnv,
  requiredRuntimeSecrets,
  schemaOwningServices,
  serviceIdentityAudiencesForService,
  serviceIdentityAudienceForService,
  validateServiceCatalog,
} from './index';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');

describe('platform service catalog executable views', () => {
  it('validates catalog structure and role ownership', () => {
    expect(validateServiceCatalog()).toEqual([]);
  });

  it('keeps event-store active in deploy/build paths but outside gateway composition', () => {
    expect(activeDropletComposeServices()).toContain('event-store-service');
    expect(imageBuildTargets()).toContain('event-store-service');
    expect(packageBuildProjects()).toContain('event-store-service');
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

  it('derives service-identity audiences from the catalog instead of keyring shape', () => {
    expect(serviceIdentityAudienceForService('farm-service')).toBe('farm');
    expect(serviceIdentityAudiencesForService('farm-service')).toEqual(['farm', 'farm-service']);
    expect(serviceIdentityAudiencesForService('event-store-service')).toEqual([
      'event-store-service',
    ]);
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

  // INFRA-HIGH-005: before frontendAssets existed, the prebuild list was
  // derived by subtraction and aquamobil (dockerfile-self-build,
  // web/apps/) leaked into the npm-workspace lane — the first full
  // deploy broke on `--workspace=web/modules/aquamobil` and the shell
  // image was never produced. These pins make the regression a test
  // failure instead of a red production deploy.
  describe('frontend prebuild plan (deploy artifact step SSOT)', () => {
    it('excludes dockerfile-self-build targets from both prebuild lanes', () => {
      const plan = frontendPrebuildPlan();
      expect(plan.nxProjects).not.toContain('aquamobil');
      expect(plan.workspaceModules.map((entry) => entry.module)).not.toContain('aquamobil');
    });

    it('covers every active frontend image target exactly once across the three strategies', () => {
      const plan = frontendPrebuildPlan();
      const selfBuild = PLATFORM_SERVICE_CATALOG.filter(
        (entry) => entry.frontendAssets === 'dockerfile-self-build',
      ).map((entry) => entry.imageTarget);
      const covered = [
        ...plan.nxProjects,
        ...plan.workspaceModules.map((entry) => entry.module),
        ...selfBuild,
      ].sort();
      expect(covered).toEqual([...frontendImageBuildTargets()].sort());
    });

    it('declares an on-disk workspace (package.json) for every frontend modulePath', () => {
      const frontends = PLATFORM_SERVICE_CATALOG.filter(
        (entry) => entry.buildKind === 'frontend' && entry.deploymentStatus === 'active',
      );
      expect(frontends.length).toBeGreaterThan(0);
      for (const entry of frontends) {
        expect(entry.modulePath).toBeDefined();
        expect(existsSync(join(REPO_ROOT, entry.modulePath as string, 'package.json'))).toBe(true);
      }
    });
  });
});
