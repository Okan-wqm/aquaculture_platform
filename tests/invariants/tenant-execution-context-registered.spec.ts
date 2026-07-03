/**
 * Platform-wide invariant — tenant schema-routing context preservation:
 *
 * Every tenant-scoped service (one that patches the pg pool via
 * `createTenantConnectionBootstrap(<src>)`) MUST also register
 * `TenantExecutionContextInterceptor` as an `APP_INTERCEPTOR` somewhere in
 * its module tree. Without that registration the service's tenant
 * search_path routing is silently unreliable.
 *
 * # Why
 *
 * `TenantSchemaMiddleware` seeds the tenant schema into AsyncLocalStorage
 * with `requestContextStorage.run(newStore, () => next())`. That `run()`
 * scope only reliably covers the Express middleware chain. Apollo GraphQL
 * resolver execution and the CQRS QueryBus add async boundaries BEFORE
 * TypeORM checks out a pg connection. On those async hops the
 * middleware-seeded context can be gone, so `TenantConnectionBootstrap`
 * reads an empty context at checkout and falls back to
 * `SET search_path TO "<src>", public` — the source/template schema.
 * The query then runs against the wrong (empty or template) schema:
 * tenant rows "disappear" intermittently and template/seed rows can
 * surface as phantom data. It is request-to-request nondeterministic,
 * which is exactly the "data sometimes loads, sometimes vanishes, data
 * that isn't mine appears" class of bug.
 *
 * `TenantExecutionContextInterceptor` is the architectural cure: it
 * re-enters `withTenantContext(tenantId, ...)` AROUND the resolver/handler
 * pipeline (`lastValueFrom(next.handle())`), so the validated tenant is
 * present in AsyncLocalStorage when the pg connection is checked out —
 * regardless of how many async hops Apollo/CQRS insert.
 *
 * `farm-service` and `event-store-service` already registered it; the
 * other six tenant-scoped GraphQL/CQRS services did not, which is the
 * asymmetry this invariant locks shut.
 *
 * # What this invariant checks
 *
 * For each service whose source tree (apps/SVC/src) calls
 * `createTenantConnectionBootstrap(` (the factory CALL — auth-service's
 * prose mention of the class name in a comment is intentionally NOT a
 * match), assert that the SSoT module `TenantExecutionContextModule`
 * (which owns the single APP_INTERCEPTOR registration in backend-common)
 * is imported in one of that service's module files (any .module.ts under
 * apps/SVC/src). The import MAY live in the AppModule (the six fixed
 * services) OR an imported feature module (farm-service's
 * FarmMetricsModule). Hand-copying the provider block instead of importing
 * the module is exactly the duplication this invariant prevents.
 *
 * # Why this lives in tests/invariants/
 *
 * The defect is invisible at compile time and at code review: the pool
 * bootstrap and the middleware both look correct in isolation. The only
 * symptom is nondeterministic empty/wrong-tenant reads at runtime. A
 * source-text invariant is the right Tier-3 (make-detectable) hedge so a
 * newly-added tenant-scoped service can never silently ship without the
 * interceptor.
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

// The factory CALL — `createTenantConnectionBootstrap('farm')`. The open
// paren is load-bearing: it excludes auth-service, whose app.module.ts
// only mentions the class name "TenantConnectionBootstrap" in prose to
// explain why it does NOT use per-tenant pool routing.
const TENANT_POOL_BOOTSTRAP_CALL = /createTenantConnectionBootstrap\s*\(/;
// The interceptor is registered through the SSoT module
// (TenantExecutionContextModule in backend-common), imported once per
// service — never via a hand-copied APP_INTERCEPTOR provider block. A
// service is compliant when one of its module files imports that module.
const SSOT_MODULE_IMPORT = /TenantExecutionContextModule\b/;

// Every NestJS module file under a service's src tree. Two glob shapes
// are required: `src/*.module.ts` matches the AppModule at the src root
// (where the createTenantConnectionBootstrap() call and the six fixed
// services' interceptor registration live), and `src/**/*.module.ts`
// matches nested feature modules (farm-service's FarmMetricsModule). A
// single `src/**/*.module.ts` glob misses the src-root AppModule because
// git pathspec `**` requires at least one intermediate directory.
function moduleFilesFor(servicePrefix: string): string[] {
  return [
    ...listFilesUnder(servicePrefix, 'src/*.module.ts'),
    ...listFilesUnder(servicePrefix, 'src/**/*.module.ts'),
  ];
}

describe('INVARIANT: tenant-scoped services register TenantExecutionContextInterceptor', () => {
  const services = listServiceTrees();

  it('discovers at least one service', () => {
    expect(services.length).toBeGreaterThan(0);
  });

  it('discovers the known tenant-scoped services', () => {
    const tenantScoped = services.filter((svc) =>
      moduleFilesFor(svc).some((f) => fileContains(f, TENANT_POOL_BOOTSTRAP_CALL)),
    );
    // farm, sensor, hr, messaging, hydroponics, ai, alert — the 7 services
    // that clone per-tenant tables into tenant_<uuid> and route via pool
    // search_path. If this number drops, a service stopped routing per
    // tenant (or the factory was renamed) — re-derive before editing.
    expect(tenantScoped.length).toBeGreaterThanOrEqual(7);
  });

  it.each(services)(
    'service %s either is not tenant-pool-routed OR imports TenantExecutionContextModule',
    (servicePrefix) => {
      const moduleFiles = moduleFilesFor(servicePrefix);
      const isTenantScoped = moduleFiles.some((f) =>
        fileContains(f, TENANT_POOL_BOOTSTRAP_CALL),
      );
      if (!isTenantScoped) return;

      const registers = moduleFiles.some((f) =>
        fileContains(f, SSOT_MODULE_IMPORT),
      );

      if (!registers) {
        throw new Error(
          `Service "${servicePrefix}" patches the pg pool for per-tenant ` +
            `search_path routing (createTenantConnectionBootstrap) but does ` +
            `NOT import TenantExecutionContextModule in any module file under ` +
            `${servicePrefix}/src. Without it, Apollo/CQRS async boundaries drop ` +
            `the middleware-seeded tenant context and queries silently fall back ` +
            `to the source schema (intermittent empty / wrong-tenant reads). ` +
            `Add the SSoT module 'TenantExecutionContextModule' ` +
            `(from @aquaculture/backend-common/context) to the AppModule imports ` +
            `(see hr-service) or an imported feature module (see farm-service ` +
            `FarmMetricsModule). Do NOT hand-copy an APP_INTERCEPTOR provider block.`,
        );
      }
    },
  );
});
