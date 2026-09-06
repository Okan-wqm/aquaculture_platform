import { createHash } from 'crypto';
import { readFileSync } from 'fs';

import yaml from 'js-yaml';

import { SCHEMA_REGISTRY } from '../../apps/db-migrate/src/schema-registry';
import {
  PLATFORM_SERVICE_CATALOG,
  backendImageBuildTargets,
  frontendImageBuildMatrix,
  frontendImageBuildTargets,
  imageBuildTargets,
  infraImageBuildMatrix,
  infraImageBuildTargets,
  readinessServices,
  gatewaySubgraphs,
  serviceDbRolePrefixes,
  serviceCatalogById,
  sharedImageRestartServices,
  validateServiceCatalog,
} from '../../platform/libs/service-catalog/src';

interface CriticalityManifest {
  services: Array<{ name: string; level: string }>;
}

interface SignalsManifest {
  services: Array<{ name: string; signals: string[] }>;
}

interface RequiredSecretsManifest {
  secrets: Array<{ name: string }>;
  runtime_required_env: Array<{ name: string }>;
}

interface ApolloSubgraphRegistry {
  subgraphs: Array<{
    name: string;
    nxProject: string;
    urlEnv: string;
    localUrl: string;
    routingUrl: string;
    schemaArtifactPath: string;
  }>;
}

interface GeneratedServiceCatalog {
  imageBuildTargets: string[];
  activeDropletComposeServices: string[];
  deploy: {
    backendImageTargets: string[];
    frontendImageTargets: string[];
    frontendImageMatrix: Array<{
      module: string;
      dockerfile: string;
      module_path: string;
      nx_project: string;
      buildInputGlobs: string[];
    }>;
    infraImageTargets: string[];
    infraImageMatrix: Array<{ image: string; dockerfile: string; context: string }>;
    applicationImageServices: string[];
    serviceDbRolePrefixes: string[];
    sharedImageRestartServices: Array<{ imageService: string; composeService: string }>;
    readinessServices: Array<{ serviceId: string; port: number }>;
  };
}

function sortSubgraphs<T extends { name: string }>(subgraphs: T[]): T[] {
  return [...subgraphs].sort((left, right) => left.name.localeCompare(right.name));
}

function readYaml<T>(path: string): T {
  return yaml.load(readFileSync(path, 'utf8')) as T;
}

function readShellStringList(source: string, name: string): string[] {
  const match = source.match(new RegExp(`${name}=(?:'([^']*)'|"([^"]*)")`));
  const value = match?.[1] ?? match?.[2];
  if (!value) return [];
  return value.split(/\s+/).filter(Boolean).sort();
}

function generatedDeployEnv(): string {
  return readFileSync('infrastructure/deploy/service-catalog.deploy.vars', 'utf8');
}

describe('platform service catalog parity', () => {
  const catalog = serviceCatalogById();

  it('validates the executable catalog shape', () => {
    expect(validateServiceCatalog()).toEqual([]);
  });

  it('keeps schema registry ownership in the platform catalog', () => {
    const registrySchemas = SCHEMA_REGISTRY.map((entry) => [
      entry.service,
      entry.schema,
      entry.migrationsGlob,
    ]);
    const registryServices = new Set(SCHEMA_REGISTRY.map((entry) => entry.service));
    const extraCatalogSchemas = PLATFORM_SERVICE_CATALOG.filter(
      (entry) => (entry.schema || entry.migration) && !registryServices.has(entry.serviceId),
    ).map((entry) => entry.serviceId);

    const catalogSchemas = SCHEMA_REGISTRY.map((entry) => {
      const catalogEntry = catalog.get(entry.service);
      if (!catalogEntry) {
        throw new Error(
          `service catalog has no entry for schema-registry service ${entry.service}`,
        );
      }
      return [
        catalogEntry.serviceId,
        catalogEntry.schema,
        [...(catalogEntry.migration?.globs ?? [])],
      ];
    });

    expect(extraCatalogSchemas).toEqual([]);
    expect(catalogSchemas).toEqual(registrySchemas);
  });

  it('keeps compose PORT env in sync with catalog containerPort (INFRA-HIGH-014)', () => {
    // Readiness sweeps curl the catalog-declared containerPort INSIDE the
    // container; a divergence between docker-compose.droplet.yml's PORT
    // env and the catalog is a false-negative production verify (the
    // 2026-06-11 class: catalog view hardcoded 3000 while observability
    // listens on 3009). Default: a compose service that declares no PORT
    // env listens on 3000.
    const compose = readFileSync('docker-compose.droplet.yml', 'utf8');
    for (const entry of readinessServices()) {
      const block =
        new RegExp(`\\n  ${entry.serviceId}:\\n[\\s\\S]*?(?=\\n  [a-zA-Z0-9_-]+:\\n|$)`).exec(
          `\n${compose}`,
        )?.[0] ?? '';
      expect(block).toContain(`${entry.serviceId}:`);
      const portMatch = /\n\s+PORT:\s*["']?(\d+)["']?/.exec(block);
      const composePort = portMatch ? Number(portMatch[1]) : 3000;
      expect({ service: entry.serviceId, port: composePort }).toEqual({
        service: entry.serviceId,
        port: entry.port,
      });
    }
  });

  it('binds every database consumer to the database selected by PostgreSQL and db-migrate', () => {
    const compose = readYaml<{
      services: { postgres: { environment: { POSTGRES_DB: string } } } &
        Record<string, { environment?: Record<string, unknown> }>;
    }>('docker-compose.droplet.yml');
    const selectedDatabase = compose.services.postgres.environment.POSTGRES_DB;
    expect(selectedDatabase).toBe('${POSTGRES_DB:-aquaculture}');
    for (const service of ['db-migrate', 'observability-service']) {
      expect(compose.services[service]).toMatchObject({
        environment: { DATABASE_NAME: selectedDatabase },
      });
    }
    for (const [service, definition] of Object.entries(compose.services)) {
      if (definition.environment && 'DATABASE_NAME' in definition.environment) {
        expect({ service, database: definition.environment.DATABASE_NAME }).toEqual({
          service,
          database: selectedDatabase,
        });
      }
    }
  });

  it('keeps service criticality levels in sync', () => {
    const manifest = readYaml<CriticalityManifest>(
      'infrastructure/deploy/service-criticality.yaml',
    );

    for (const service of manifest.services) {
      expect(catalog.get(service.name)?.criticality).toBe(service.level);
    }
  });

  it('keeps required boot signals in sync for cataloged services', () => {
    const manifest = readYaml<SignalsManifest>('infrastructure/deploy/required-signals.yaml');
    const signalsByService = new Map(
      manifest.services.map((service) => [service.name, service.signals]),
    );

    for (const entry of PLATFORM_SERVICE_CATALOG) {
      if (entry.requiredSignals.length === 0) {
        continue;
      }
      expect(signalsByService.get(entry.serviceId)).toEqual([...entry.requiredSignals]);
    }
  });

  it('keeps generated catalog deploy image targets in sync with the source catalog', () => {
    const generated = JSON.parse(
      readFileSync('infrastructure/deploy/service-catalog.generated.json', 'utf8'),
    ) as GeneratedServiceCatalog;

    expect(generated.imageBuildTargets.sort()).toEqual([...imageBuildTargets()].sort());
    expect(generated.deploy.backendImageTargets.sort()).toEqual(
      [...backendImageBuildTargets()].sort(),
    );
    expect(generated.deploy.frontendImageTargets.sort()).toEqual(
      [...frontendImageBuildTargets()].sort(),
    );
    expect(generated.deploy.frontendImageMatrix).toEqual(
      frontendImageBuildMatrix().map((entry) => ({
        module: entry.module,
        dockerfile: entry.dockerfile,
        module_path: entry.modulePath,
        nx_project: entry.nxProject,
        buildInputGlobs: entry.buildInputGlobs,
      })),
    );
    expect(generated.deploy.infraImageTargets.sort()).toEqual([...infraImageBuildTargets()].sort());
    expect(generated.deploy.infraImageMatrix).toEqual([...infraImageBuildMatrix()]);
    expect(generated.deploy.applicationImageServices.sort()).toEqual(
      [...imageBuildTargets()].sort(),
    );
    expect(generated.deploy.serviceDbRolePrefixes.sort()).toEqual(
      [...serviceDbRolePrefixes()].sort(),
    );
    expect(generated.deploy.sharedImageRestartServices).toEqual([...sharedImageRestartServices()]);
    expect(generated.deploy.readinessServices).toEqual([...readinessServices()]);
  });

  it('keeps generated deploy shell artifact aligned with catalog image targets', () => {
    const deployEnv = generatedDeployEnv();
    const generatedTargets = readShellStringList(deployEnv, 'CATALOG_APPLICATION_IMAGE_SERVICES');

    expect(readShellStringList(deployEnv, 'CATALOG_BACKEND_IMAGE_SERVICES')).toEqual(
      [...backendImageBuildTargets()].sort(),
    );
    expect(readShellStringList(deployEnv, 'CATALOG_FRONTEND_IMAGE_SERVICES')).toEqual(
      [...frontendImageBuildTargets()].sort(),
    );
    expect(readShellStringList(deployEnv, 'CATALOG_INFRA_IMAGE_SERVICES')).toEqual(
      [...infraImageBuildTargets()].sort(),
    );
    expect(readShellStringList(deployEnv, 'CATALOG_SERVICE_DB_ROLE_PREFIXES')).toEqual(
      [...serviceDbRolePrefixes()].sort(),
    );
    expect(readShellStringList(deployEnv, 'CATALOG_READINESS_SERVICES')).toEqual(
      readinessServices()
        .map((entry) => `${entry.serviceId}:${entry.port}`)
        .sort(),
    );
    expect(readShellStringList(deployEnv, 'CATALOG_GATEWAY_RECOMPOSITION_SERVICES')).toEqual(
      gatewaySubgraphs()
        .map((entry) => entry.nxProject)
        .sort(),
    );
    expect(readShellStringList(deployEnv, 'CATALOG_SHARED_IMAGE_RESTART_SERVICES')).toEqual(
      sharedImageRestartServices()
        .map((entry) => `${entry.imageService}:${entry.composeService}`)
        .sort(),
    );
    expect(generatedTargets).toEqual([...imageBuildTargets()].sort());
    expect(generatedTargets).toContain('event-store-service');
    expect(generatedTargets).toContain('mosquitto');
    expect(generatedTargets).not.toContain('sensor-ingestion');
  });

  it('classifies event-store as an internal ledger, not a gateway subgraph', () => {
    const eventStore = catalog.get('event-store-service');
    expect(eventStore?.classification).toBe('internal-service');
    expect(eventStore?.gatewayParticipation).toBe('none');

    const gatewayCompose = readFileSync('docker-compose.droplet.yml', 'utf8');
    expect(gatewayCompose).not.toContain('EVENT_STORE_SERVICE_URL');
  });

  it('keeps Apollo subgraph registry in sync with catalog gateway participation', () => {
    const registry = JSON.parse(
      readFileSync('infrastructure/apollo-router/subgraphs.json', 'utf8'),
    ) as ApolloSubgraphRegistry;

    expect(
      sortSubgraphs(
        registry.subgraphs.map(
          ({ name, nxProject, urlEnv, localUrl, routingUrl, schemaArtifactPath }) => ({
            name,
            nxProject,
            urlEnv,
            localUrl,
            routingUrl,
            schemaArtifactPath,
          }),
        ),
      ),
    ).toEqual(sortSubgraphs([...gatewaySubgraphs()]));
  });

  it('keeps generated GraphQL artifacts pinned to the subgraph registry hash', () => {
    const registryText = readFileSync('infrastructure/apollo-router/subgraphs.json', 'utf8');
    const registry = JSON.parse(registryText) as ApolloSubgraphRegistry;
    const registryHash = createHash('sha256').update(registryText).digest('hex');
    const gatewayGenerated = readFileSync(
      'apps/gateway-api/src/config/federated-subgraphs.generated.ts',
      'utf8',
    );
    const supergraphConfig = readFileSync(
      'infrastructure/apollo-router/supergraph-config.generated.yaml',
      'utf8',
    );
    const codegenSchema = JSON.parse(
      readFileSync('infrastructure/apollo-router/codegen-schema.generated.json', 'utf8'),
    ) as { registryHash: string; schemaArtifactPaths: string[] };

    expect(gatewayGenerated).toContain(`Registry SHA256: ${registryHash}`);
    expect(supergraphConfig).toContain(`Registry SHA256: ${registryHash}`);
    expect(codegenSchema.registryHash).toBe(registryHash);
    expect(codegenSchema.schemaArtifactPaths).toEqual(
      registry.subgraphs.map((subgraph) => subgraph.schemaArtifactPath),
    );
  });

  it('requires cataloged runtime boundaries in the deploy env manifest', () => {
    const manifest = readYaml<RequiredSecretsManifest>(
      'infrastructure/deploy/required-secrets.yaml',
    );
    const declared = new Set([
      ...manifest.secrets.map((entry) => entry.name),
      ...manifest.runtime_required_env.map((entry) => entry.name),
    ]);

    for (const name of [
      'CONFIG_SERVICE_DB_PASS',
      'EVENT_STORE_SERVICE_DB_PASS',
      'FRONTEND_URL',
      'SERVICE_IDENTITY_KEYRING',
      'SPACES_ENDPOINT',
      'SPACES_REGION',
      'WALG_BACKUP_EPOCH',
      'WALG_SPACES_BUCKET',
    ]) {
      expect(declared.has(name)).toBe(true);
    }
  });

  it('keeps production deploy workflow affected image selection catalog-driven', () => {
    const workflow = readFileSync('.github/workflows/deploy-digitalocean.yml', 'utf8');

    expect(workflow).toContain('service-catalog.deploy.vars');
    expect(workflow).toContain('CATALOG_BACKEND_IMAGE_SERVICES');
    expect(workflow).toContain('CATALOG_FRONTEND_IMAGE_SERVICES');
    expect(workflow).toContain('CATALOG_INFRA_IMAGE_SERVICES');
    expect(workflow).toContain('AFFECTED_BACKEND=("${ALL_BACKEND[@]}")');
    expect(workflow).toContain('AFFECTED_FRONTEND=("${ALL_FRONTEND[@]}")');
    expect(workflow).toContain('AFFECTED_INFRA_IMAGES=("${ALL_INFRA_IMAGES[@]}")');
    expect(workflow).not.toContain('SERVICE_CATALOG_DEPLOY_ENV');
    expect(workflow).not.toContain('service-catalog.deploy.env');
  });

  it('keeps droplet deploy script catalog-driven for image and DB-role surfaces', () => {
    const script = readFileSync('scripts/deploy/droplet-up.sh', 'utf8');

    expect(script).toContain('service-catalog.deploy.vars');
    expect(script).toContain('CATALOG_APPLICATION_IMAGE_SERVICES');
    expect(script).toContain('CATALOG_SERVICE_DB_ROLE_PREFIXES');
    expect(script).not.toContain('SERVICE_DB_ROLES="AUTH TENANT FARM');
    expect(script).not.toContain('service-catalog.deploy.env');
  });

  it('keeps production post-deploy readiness catalog-driven', () => {
    const script = readFileSync('scripts/deploy/post-deploy-verify.sh', 'utf8');

    expect(script).toContain('service-catalog.deploy.vars');
    expect(script).toContain('CATALOG_READINESS_SERVICES');
    expect(script).toContain('for spec in "${ready_services[@]}"');
    expect(script).not.toContain('service-catalog.deploy.env');
  });
});
