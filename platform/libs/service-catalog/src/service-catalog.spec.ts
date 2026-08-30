import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  MIGRATION_BOOT_SIGNAL_CONTRACT,
  PLATFORM_SERVICE_CATALOG,
  activeDropletComposeServices,
  activeDropletServices,
  frontendImageBuildTargets,
  frontendPrebuildPlan,
  gatewaySubgraphs,
  imageBuildTargets,
  infraImageBuildMatrix,
  packageBuildProjects,
  requiredRuntimeEnv,
  requiredRuntimeSecrets,
  schemaOwningServices,
  serviceIdentityAudiencesForService,
  serviceIdentityAudienceForService,
  serviceIdentityCallers,
  validateServiceCatalog,
  readinessServices,
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

  it('derives the service-identity CALLER allowlist from the catalog (single SSoT, #388 regression)', () => {
    const callers = serviceIdentityCallers();

    // Every real signer binds its catalog serviceId into X-Service-Identity
    // (verified against buildSignedInternalHeaders/signedFetch callsites):
    // gateway-api, admin-api-service, notification-service. Plus every backend
    // that holds the shared keyring and can sign.
    expect(callers).toEqual(
      expect.arrayContaining([
        'gateway-api',
        'auth-service',
        'admin-api-service',
        'notification-service',
        'event-store-service',
      ]),
    );

    // Non-empty, sorted, de-duplicated. An EMPTY allowlist is the #388 outage
    // shape — it would fail-close every caller, so this pins it can never be [].
    expect(callers.length).toBeGreaterThan(0);
    expect([...callers]).toEqual([...callers].sort());
    expect(new Set(callers).size).toBe(callers.length);

    // Equals exactly the active-droplet backend node-service set, so adding a
    // service to the catalog auto-extends the allowlist (zero-effort default).
    const expected = [
      ...new Set(
        activeDropletServices()
          .filter(
            (entry) =>
              entry.buildKind === 'node-service' &&
              ['gateway', 'subgraph', 'internal-service'].includes(entry.classification),
          )
          .map((entry) => entry.serviceId),
      ),
    ].sort();
    expect([...callers]).toEqual(expected);

    // Frontends, infra and one-shot jobs are NOT signers.
    expect(callers).not.toContain('shell');
    expect(callers).not.toContain('postgres');
    expect(callers).not.toContain('db-migrate');
  });

  it('separates operator-provided runtime env from secret material', () => {
    expect(requiredRuntimeEnv()).not.toContain('SERVICE_IDENTITY_KEYRING');
    expect(requiredRuntimeEnv()).not.toContain('EVENT_STORE_SERVICE_DB_PASS');
    expect(requiredRuntimeSecrets()).toContain('EVENT_STORE_SERVICE_DB_PASS');
    expect(requiredRuntimeSecrets()).toContain('SERVICE_IDENTITY_KEYRING');
    expect(requiredRuntimeSecrets()).toContain('CONFIG_SERVICE_DB_PASS');
  });

  it('derives every production infra build from the catalog', () => {
    expect(infraImageBuildMatrix()).toEqual([
      {
        image: 'postgres',
        dockerfile: 'infrastructure/docker/Dockerfile.postgres-walg',
        context: '.',
      },
      {
        image: 'mosquitto',
        dockerfile: 'infrastructure/mosquitto/Dockerfile',
        context: 'infrastructure/mosquitto',
      },
    ]);

    for (const build of infraImageBuildMatrix()) {
      expect(existsSync(join(REPO_ROOT, build.dockerfile))).toBe(true);
      expect(existsSync(join(REPO_ROOT, build.context))).toBe(true);
    }
  });

  it('keeps WAL-G object-store coordinates in generated runtime configuration', () => {
    expect(requiredRuntimeEnv()).toEqual(
      expect.arrayContaining([
        'SPACES_ENDPOINT',
        'SPACES_REGION',
        'WALG_BACKUP_EPOCH',
        'WALG_SPACES_BUCKET',
      ]),
    );
    expect(requiredRuntimeSecrets()).not.toEqual(
      expect.arrayContaining([
        'SPACES_ENDPOINT',
        'SPACES_REGION',
        'WALG_BACKUP_EPOCH',
        'WALG_SPACES_BUCKET',
      ]),
    );
  });

  it('rejects docker-only entries without catalog-owned build coordinates', () => {
    const invalid = PLATFORM_SERVICE_CATALOG.map((entry) =>
      entry.serviceId === 'postgres' ? { ...entry, infraImageBuild: undefined } : entry,
    );

    expect(validateServiceCatalog(invalid)).toContainEqual({
      serviceId: 'postgres',
      message: 'docker-only service must declare imageTarget and infraImageBuild',
    });
  });

  it('exposes container ports through the readiness view (INFRA-HIGH-014)', () => {
    const ready = new Map(readinessServices().map((entry) => [entry.serviceId, entry.port]));
    // Platform default stays 3000…
    expect(ready.get('gateway-api')).toBe(3000);
    expect(ready.get('messaging-service')).toBe(3000);
    // …and the one declared deviation flows through instead of a
    // hardcoded constant (compose sets PORT: 3009 for observability —
    // the hardcoded-3000 view produced a false-negative production
    // verify on 2026-06-11).
    expect(ready.get('observability-service')).toBe(3009);
  });

  it('declares one migration authority for every schema-owning runtime service', () => {
    for (const entry of schemaOwningServices()) {
      expect(entry.dbRoles?.owner).toMatch(/_schema_owner$/);
      expect(entry.dbRoles?.migrator).toBe('db_migrate');
      expect(entry.dbRoles?.runtime).toMatch(/_service$/);
      expect(entry.privilegeMode).toBe('dml-only');
    }
  });

  it('keeps db-migrate as the only migration boot signal authority (INFRA-CRITICAL-015)', () => {
    const migrationSignalRefs = PLATFORM_SERVICE_CATALOG.flatMap((entry) =>
      entry.requiredSignals
        .filter(
          (signal) =>
            signal === MIGRATION_BOOT_SIGNAL_CONTRACT.completeSignal ||
            signal === MIGRATION_BOOT_SIGNAL_CONTRACT.retiredRunnerSignal,
        )
        .map((signal) => ({ serviceId: entry.serviceId, signal })),
    );

    expect(migrationSignalRefs).toEqual([
      {
        serviceId: MIGRATION_BOOT_SIGNAL_CONTRACT.authorityServiceId,
        signal: MIGRATION_BOOT_SIGNAL_CONTRACT.completeSignal,
      },
    ]);

    const catalogWithLegacyRunnerSignal = PLATFORM_SERVICE_CATALOG.map((entry) =>
      entry.serviceId === 'auth-service'
        ? {
            ...entry,
            requiredSignals: [
              ...entry.requiredSignals,
              MIGRATION_BOOT_SIGNAL_CONTRACT.retiredRunnerSignal,
            ],
          }
        : entry,
    );
    expect(validateServiceCatalog(catalogWithLegacyRunnerSignal)).toContainEqual({
      serviceId: 'auth-service',
      message: 'migration_runner_applied is retired; db-migrate owns migration boot signals',
    });

    const catalogWithDuplicateDbMigrateSignal = PLATFORM_SERVICE_CATALOG.map((entry) =>
      entry.serviceId === 'auth-service'
        ? {
            ...entry,
            requiredSignals: [
              ...entry.requiredSignals,
              MIGRATION_BOOT_SIGNAL_CONTRACT.completeSignal,
            ],
          }
        : entry,
    );
    expect(validateServiceCatalog(catalogWithDuplicateDbMigrateSignal)).toContainEqual({
      serviceId: 'auth-service',
      message: 'db_migrate_complete may only be required by db-migrate',
    });
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
