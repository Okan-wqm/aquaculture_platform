import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import {
  deployedCatalogEntries,
  PLATFORM_SERVICE_CATALOG,
  schemaOwnerCatalogEntries,
} from '../../platform/service-catalog';
import { SCHEMA_REGISTRY } from '../../apps/db-migrate/src/schema-registry';

const REPO_ROOT = resolve(__dirname, '..', '..');

interface CriticalityManifest {
  services: Array<{ name: string; level: string; profiles?: string[] }>;
}

interface SignalsManifest {
  services: Array<{ name: string; signals: string[] }>;
}

function readYaml<T>(path: string): T {
  return yaml.load(readFileSync(resolve(REPO_ROOT, path), 'utf8')) as T;
}

function read(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf8');
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

describe('platform service catalog SSOT', () => {
  const criticality = readYaml<CriticalityManifest>(
    'infrastructure/deploy/service-criticality.yaml',
  );
  const signals = readYaml<SignalsManifest>(
    'infrastructure/deploy/required-signals.yaml',
  );

  it('has unique service names', () => {
    const names = PLATFORM_SERVICE_CATALOG.map((entry) => entry.name);
    expect(sorted(new Set(names))).toEqual(sorted(names));
  });

  it('keeps deployed services aligned with criticality manifest', () => {
    const catalog = deployedCatalogEntries()
      .filter((entry) => entry.criticality)
      .map((entry) => [entry.name, entry.criticality, entry.profiles ?? []]);
    const manifest = criticality.services.map((entry) => [
      entry.name,
      entry.level,
      entry.profiles ?? [],
    ]);

    expect(sorted(catalog.map(([name]) => String(name)))).toEqual(
      sorted(manifest.map(([name]) => String(name))),
    );

    for (const [name, level, profiles] of catalog) {
      expect(manifest).toContainEqual([name, level, profiles]);
    }
  });

  it('keeps deployed boot signal expectations aligned with required-signals manifest', () => {
    const catalog = new Map(
      deployedCatalogEntries()
        .filter((entry) => (entry.requiredSignals ?? []).length > 0)
        .map((entry) => [entry.name, sorted(entry.requiredSignals ?? [])]),
    );
    const manifest = new Map(
      signals.services.map((entry) => [entry.name, sorted(entry.signals)]),
    );

    expect(sorted(catalog.keys())).toEqual(sorted(manifest.keys()));

    for (const [name, requiredSignals] of catalog) {
      expect(manifest.get(name)).toEqual(requiredSignals);
    }
  });

  it('keeps schema-owner catalog entries aligned with db-migrate schema registry', () => {
    const catalog = schemaOwnerCatalogEntries().map((entry) => ({
      service: entry.name,
      schema: entry.schema,
    }));
    const registry = SCHEMA_REGISTRY.map((entry) => ({
      service: entry.service,
      schema: entry.schema,
    }));

    expect(catalog).toEqual(registry);
  });

  it('models db-migrate as a migration job, not a schema owner', () => {
    const dbMigrate = PLATFORM_SERVICE_CATALOG.find(
      (entry) => entry.name === 'db-migrate',
    );

    expect(dbMigrate).toMatchObject({
      kind: 'migration-job',
      deploymentStatus: 'deployed',
    });
    expect(dbMigrate?.schemaOwner).toBeUndefined();
  });

  it('models event-store-service as promoted canonical runtime ledger', () => {
    const eventStore = PLATFORM_SERVICE_CATALOG.find(
      (entry) => entry.name === 'event-store-service',
    );

    expect(eventStore).toMatchObject({
      schema: 'event_store',
      schemaOwner: true,
      deploymentStatus: 'deployed',
      criticality: 'critical',
      requiredSignals: ['schema_drift_clean'],
    });
  });

  it('keeps event-store promotion wired through deploy, compose, and ready gates', () => {
    const compose = read('docker-compose.droplet.yml');
    const deployScript = read('scripts/deploy/droplet-up.sh');
    const workflow = read('.github/workflows/deploy-digitalocean.yml');

    expect(workflow).toContain('event-store-service');
    expect(deployScript).toContain('event-store-service');
    expect(deployScript).toContain('"event-store-service:3000"');
    expect(compose).toContain('event-store-service:');
    expect(compose).toContain('ghcr.io/okan-wqm/aquaculture_platform/event-store-service');
    expect(compose).toContain('curl", "-sf", "http://localhost:3000/health/ready"');
    expect(compose).toContain('DATABASE_MIGRATIONS_RUN: "false"');
    expect(compose).toContain('DB_MIGRATE_AUTHORITATIVE: "true"');
    expect(compose).toContain(
      'EVENT_STORE_ALLOWED_SERVICE_TENANT_SCOPES: ${EVENT_STORE_ALLOWED_SERVICE_TENANT_SCOPES:?EVENT_STORE_ALLOWED_SERVICE_TENANT_SCOPES required}',
    );
  });
});
