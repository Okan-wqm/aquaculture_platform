import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import yaml from 'js-yaml';

import { serviceCatalogById } from '../../platform/libs/service-catalog/src';

const REPO_ROOT = resolve(__dirname, '..', '..');
const ADMIN_REST_URL = 'http://admin-api-service:3000';
const ENCRYPTION_KEY_ALIAS = '${ENCRYPTION_KEY:?ENCRYPTION_KEY is required}';
const LOCAL_DEV_SIGNING_FALLBACK =
  'local-dev-only-change-me-feature-evaluation-signing-secret-32-byte-minimum';
const LOCAL_DEV_SIGNING_SECRET =
  '${SERVICE_IDENTITY_SIGNING_SECRET:-local-dev-only-change-me-feature-evaluation-signing-secret-32-byte-minimum}';

interface ComposeService {
  environment?: Record<string, string>;
}

interface ComposeDocument {
  services: Record<string, ComposeService>;
}

const REQUIRED_SERVICE_IDENTITY_ENV = [
  'SERVICE_IDENTITY_KEYRING',
  'SERVICE_IDENTITY_SIGNING_KID',
] as const;

function read(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf8');
}

function compose(path: string): ComposeDocument {
  return yaml.load(read(path)) as ComposeDocument;
}

function requiredService(
  document: ComposeDocument,
  serviceName: string,
  composePath: string,
): ComposeService {
  const service = document.services[serviceName];
  if (!service) throw new Error(`${composePath}: service not found: ${serviceName}`);
  return service;
}

function mergeService(base: ComposeService, override: ComposeService | undefined): ComposeService {
  return {
    ...base,
    ...override,
    environment: {
      ...base.environment,
      ...override?.environment,
    },
  };
}

function locationBlock(source: string, location: string): string {
  const marker = `location ${location} {`;
  const start = source.indexOf(marker);
  if (start === -1) throw new Error(`nginx location not found: ${location}`);

  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }

  throw new Error(`nginx location is not closed: ${location}`);
}

describe('Marine Explorer production and edge wiring', () => {
  const base = compose('docker-compose.yml');
  const dev = compose('docker-compose.dev.yml');
  const prod = compose('docker-compose.prod.yml');
  const droplet = compose('docker-compose.droplet.yml');
  const stagingOverride = compose('docker-compose.staging.yml');
  const staging = {
    gateway: mergeService(
      requiredService(droplet, 'gateway-api', 'docker-compose.droplet.yml'),
      stagingOverride.services['gateway-api'],
    ),
    farm: mergeService(
      requiredService(droplet, 'farm-service', 'docker-compose.droplet.yml'),
      stagingOverride.services['farm-service'],
    ),
    dbMigrate: mergeService(
      requiredService(droplet, 'db-migrate', 'docker-compose.droplet.yml'),
      stagingOverride.services['db-migrate'],
    ),
  };

  it('wires the internal admin REST boundary for gateway and farm in every full stack', () => {
    const stacks = [
      {
        name: 'base',
        gateway: requiredService(base, 'gateway-api', 'docker-compose.yml'),
        farm: requiredService(base, 'farm-service', 'docker-compose.yml'),
      },
      {
        name: 'dev',
        gateway: requiredService(dev, 'gateway-api', 'docker-compose.dev.yml'),
        farm: requiredService(dev, 'farm-service', 'docker-compose.dev.yml'),
      },
      {
        name: 'prod',
        gateway: requiredService(prod, 'gateway-api', 'docker-compose.prod.yml'),
        farm: requiredService(prod, 'farm-service', 'docker-compose.prod.yml'),
      },
      {
        name: 'droplet',
        gateway: requiredService(droplet, 'gateway-api', 'docker-compose.droplet.yml'),
        farm: requiredService(droplet, 'farm-service', 'docker-compose.droplet.yml'),
      },
      { name: 'staging', gateway: staging.gateway, farm: staging.farm },
    ];

    for (const stack of stacks) {
      expect({
        stack: stack.name,
        value: stack.gateway.environment?.ADMIN_SERVICE_REST_URL,
      }).toEqual({ stack: stack.name, value: ADMIN_REST_URL });
      expect({ stack: stack.name, value: stack.farm.environment?.ADMIN_SERVICE_REST_URL }).toEqual({
        stack: stack.name,
        value: ADMIN_REST_URL,
      });
    }
  });

  it('aliases existing Sentinel and Regulatory transformers to one deployed key source', () => {
    const farmServices = [
      {
        name: 'base',
        service: requiredService(base, 'farm-service', 'docker-compose.yml'),
      },
      {
        name: 'dev',
        service: requiredService(dev, 'farm-service', 'docker-compose.dev.yml'),
      },
      {
        name: 'prod',
        service: requiredService(prod, 'farm-service', 'docker-compose.prod.yml'),
      },
      {
        name: 'droplet',
        service: requiredService(droplet, 'farm-service', 'docker-compose.droplet.yml'),
      },
      { name: 'staging', service: staging.farm },
    ];
    const migrationServices = [
      {
        name: 'prod',
        service: requiredService(prod, 'db-migrate', 'docker-compose.prod.yml'),
      },
      {
        name: 'droplet',
        service: requiredService(droplet, 'db-migrate', 'docker-compose.droplet.yml'),
      },
      { name: 'staging', service: staging.dbMigrate },
    ];

    for (const { name, service } of [...farmServices, ...migrationServices]) {
      expect({ stack: name, value: service.environment?.SENTINEL_HUB_ENCRYPTION_KEY }).toEqual({
        stack: name,
        value: ENCRYPTION_KEY_ALIAS,
      });
      expect({ stack: name, value: service.environment?.REGULATORY_ENCRYPTION_KEY }).toEqual({
        stack: name,
        value: ENCRYPTION_KEY_ALIAS,
      });
    }
  });

  it('records the exact runtime boundary names in the service catalog', () => {
    const catalog = serviceCatalogById();

    expect(catalog.get('gateway-api')?.requiredEnv).toContain('ADMIN_SERVICE_REST_URL');
    expect(catalog.get('farm-service')?.requiredEnv).toContain('ADMIN_SERVICE_REST_URL');
    expect(catalog.get('farm-service')?.requiredSecrets).toEqual(
      expect.arrayContaining([
        'ENCRYPTION_KEY',
        'SENTINEL_HUB_ENCRYPTION_KEY',
        'REGULATORY_ENCRYPTION_KEY',
      ]),
    );
    expect(catalog.get('db-migrate')?.requiredSecrets).toEqual(
      expect.arrayContaining(['SENTINEL_HUB_ENCRYPTION_KEY', 'REGULATORY_ENCRYPTION_KEY']),
    );
    expect(catalog.get('admin-api-service')?.requiredSecrets).toContain('SERVICE_IDENTITY_KEYRING');
    expect(catalog.get('admin-api-service')?.requiredEnv).toContain('SERVICE_IDENTITY_SIGNING_KID');
  });

  it('passes the production identity keyring to every feature-evaluation participant', () => {
    const participants = [
      requiredService(prod, 'gateway-api', 'docker-compose.prod.yml'),
      requiredService(prod, 'farm-service', 'docker-compose.prod.yml'),
      requiredService(prod, 'admin-api-service', 'docker-compose.prod.yml'),
      requiredService(droplet, 'gateway-api', 'docker-compose.droplet.yml'),
      requiredService(droplet, 'farm-service', 'docker-compose.droplet.yml'),
      requiredService(droplet, 'admin-api-service', 'docker-compose.droplet.yml'),
    ];

    for (const participant of participants) {
      for (const name of REQUIRED_SERVICE_IDENTITY_ENV) {
        expect(participant.environment?.[name]).toBeDefined();
        expect(participant.environment?.[name]).not.toBe('');
      }
    }
  });

  it('shares one explicit local-only signer across each development participant', () => {
    for (const [composePath, document] of [
      ['docker-compose.yml', base],
      ['docker-compose.dev.yml', dev],
    ] as const) {
      const secrets = ['gateway-api', 'farm-service', 'admin-api-service'].map(
        (serviceName) =>
          requiredService(document, serviceName, composePath).environment
            ?.SERVICE_IDENTITY_SIGNING_SECRET,
      );

      expect(secrets).toEqual([
        LOCAL_DEV_SIGNING_SECRET,
        LOCAL_DEV_SIGNING_SECRET,
        LOCAL_DEV_SIGNING_SECRET,
      ]);
    }

    expect(Buffer.byteLength(LOCAL_DEV_SIGNING_FALLBACK, 'utf8')).toBeGreaterThanOrEqual(32);
  });

  it('keeps both production nginx topologies streaming-safe on the canonical prefix', () => {
    const dockerProd = locationBlock(
      read('infrastructure/docker/nginx/nginx.prod.conf'),
      '^~ /api/marine-explorer/',
    );
    const dropletProd = locationBlock(
      read('infrastructure/nginx/droplet.conf'),
      '^~ /api/marine-explorer/',
    );

    expect(dockerProd).toContain('proxy_pass http://gateway;');
    expect(dropletProd).toContain('proxy_pass http://$backend_gw_marine:3000;');

    for (const block of [dockerProd, dropletProd]) {
      expect(block).toMatch(/proxy_http_version\s+1\.1;/);
      expect(block).toMatch(/proxy_set_header\s+Connection\s+"";/);
      expect(block).toMatch(/proxy_set_header\s+Host\s+\$host;/);
      expect(block).toMatch(/proxy_set_header\s+X-Forwarded-For\s+\$proxy_add_x_forwarded_for;/);
      expect(block).toMatch(/proxy_set_header\s+X-Forwarded-Proto\s+\$scheme;/);
      expect(block).toMatch(/proxy_buffering\s+off;/);
      expect(block).toMatch(/proxy_request_buffering\s+off;/);
      expect(block).toMatch(/proxy_cache\s+off;/);
      expect(block).toMatch(/proxy_send_timeout\s+300s;/);
      expect(block).toMatch(/proxy_read_timeout\s+300s;/);
      expect(block).not.toMatch(/rewrite\s+\^\/api\//);
    }
  });
});
