/**
 * Platform-wide invariant — freshly-provisioned tenants must not be blocked
 * by a stale negative schema-existence cache:
 *
 * Every service that applies `TenantSchemaMiddleware` (one that calls
 * `createTenantSchemaMiddleware(<src>)`) MUST import `TenantSchemaCacheModule`
 * in one of its module files.
 *
 * # Why
 *
 * `TenantSchemaMiddleware` now takes the schema-existence cache via DI
 * (`TenantSchemaCacheService`) instead of constructing a private
 * `new SchemaLRUCache`. The shared instance is provided by
 * `TenantSchemaCacheModule`, which ALSO registers
 * `TenantSchemaCacheInvalidationSubscriber` — the subscriber that clears the
 * negative cache on `TenantProvisioned` so a newly provisioned tenant is never
 * blocked by a stale "Tenant not provisioned" entry for up to the 30s negative
 * TTL.
 *
 * Two failure modes this locks shut:
 *   1. A service applies the middleware but forgets to import the module →
 *      runtime DI failure at boot (the middleware can't resolve
 *      TenantSchemaCacheService). The build does NOT catch missing DI wiring;
 *      this static invariant does.
 *   2. A service imports the cache service but not the module that registers
 *      the invalidation subscriber → the stale-negative-cache race reopens.
 *
 * # What this invariant checks
 *
 * For each service whose source tree (apps/SVC/src) calls
 * `createTenantSchemaMiddleware(`, assert that `TenantSchemaCacheModule` is
 * imported in one of that service's module files (any .module.ts under
 * apps/SVC/src — typically the AppModule).
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

function listServiceTrees(): string[] {
  const out = execFileSync(
    'git',
    ['-C', REPO_ROOT, 'ls-files', 'apps/*/src/app.module.ts'],
    { encoding: 'utf8' },
  );
  return out
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((f) => f.replace(/\/src\/app\.module\.ts$/, ''));
}

function listFilesUnder(servicePrefix: string, glob: string): string[] {
  try {
    const out = execFileSync(
      'git',
      ['-C', REPO_ROOT, 'ls-files', `${servicePrefix}/${glob}`],
      { encoding: 'utf8' },
    );
    return out.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function fileContains(rel: string, pattern: RegExp): boolean {
  try {
    const src = readFileSync(resolve(REPO_ROOT, rel), 'utf8');
    return pattern.test(src);
  } catch {
    return false;
  }
}

// Both glob shapes: `src/*.module.ts` matches the AppModule at the src root,
// `src/**/*.module.ts` matches nested feature modules. A single
// `src/**/*.module.ts` glob misses the src-root AppModule because git pathspec
// `**` requires at least one intermediate directory.
function moduleFilesFor(servicePrefix: string): string[] {
  return [
    ...listFilesUnder(servicePrefix, 'src/*.module.ts'),
    ...listFilesUnder(servicePrefix, 'src/**/*.module.ts'),
  ];
}

// The factory CALL — `createTenantSchemaMiddleware('farm')`. The open paren
// keeps a prose mention of the class name from matching.
const TENANT_SCHEMA_MIDDLEWARE_CALL = /createTenantSchemaMiddleware\s*\(/;
const CACHE_MODULE_IMPORT = /TenantSchemaCacheModule\b/;

describe('INVARIANT: services applying TenantSchemaMiddleware import TenantSchemaCacheModule', () => {
  const services = listServiceTrees();

  it('discovers at least one service', () => {
    expect(services.length).toBeGreaterThan(0);
  });

  it('discovers the seven tenant-scoped middleware services', () => {
    const usingMiddleware = services.filter((svc) =>
      moduleFilesFor(svc).some((f) => fileContains(f, TENANT_SCHEMA_MIDDLEWARE_CALL)),
    );
    // farm, sensor, hr, messaging, hydroponics, ai, alert — the seven services
    // that route per-tenant search_path via TenantSchemaMiddleware.
    expect(usingMiddleware.length).toBeGreaterThanOrEqual(7);
  });

  it.each(services)(
    'service %s either does not apply TenantSchemaMiddleware OR imports TenantSchemaCacheModule',
    (servicePrefix) => {
      const moduleFiles = moduleFilesFor(servicePrefix);
      const appliesMiddleware = moduleFiles.some((f) =>
        fileContains(f, TENANT_SCHEMA_MIDDLEWARE_CALL),
      );
      if (!appliesMiddleware) return;

      const importsModule = moduleFiles.some((f) => fileContains(f, CACHE_MODULE_IMPORT));

      if (!importsModule) {
        throw new Error(
          `Service "${servicePrefix}" applies TenantSchemaMiddleware ` +
            `(createTenantSchemaMiddleware) but does NOT import ` +
            `TenantSchemaCacheModule in any module file under ${servicePrefix}/src. ` +
            `The middleware now resolves its schema-existence cache via DI ` +
            `(TenantSchemaCacheService) — without the module the service fails ` +
            `DI resolution at boot, AND the freshly-provisioned-tenant negative-` +
            `cache invalidation (TenantProvisioned subscriber) never registers. ` +
            `Add 'TenantSchemaCacheModule' (from @aquaculture/backend-common/database) ` +
            `to the AppModule imports.`,
        );
      }
    },
  );
});
