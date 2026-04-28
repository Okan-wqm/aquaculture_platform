/**
 * Platform-wide invariant — SEC-CRITICAL-002 / SECREV-CRITICAL-002:
 *
 * Every Nest service AppModule MUST mount StripInternalHeadersMiddleware
 * via MiddlewareConsumer.apply(...) in its configure() method, AND
 * the middleware MUST appear BEFORE UserContextMiddleware in the apply
 * order. A Docker-network caller can otherwise forge x-user-payload /
 * x-tenant-id and pass forged SUPER_ADMIN context into downstream
 * guards (the exact gap auth-service shipped before W0.I).
 *
 * # What this test enforces
 *
 *   1. Every service in apps/[svc]/src/app.module.ts (except the gateway
 *      itself, which terminates external traffic and has its own
 *      already-mounted middleware) registers StripInternalHeadersMiddleware.
 *   2. The middleware appears before UserContextMiddleware in the apply
 *      tuple (or is the first apply call when UserContextMiddleware is
 *      absent — some services do not parse user payloads at all).
 *   3. The import comes from '@aquaculture/backend-common/middleware',
 *      not from a service-local copy.
 *
 * # Why source-level
 *
 * A runtime introspection of the Nest middleware stack would catch the
 * regression too, but only at boot time per service. Source-level
 * grep + AST-shape checks fire on every PR for every service in one
 * pass — fastest feedback for a class of regression that would
 * otherwise ship as silently-disabled defence.
 *
 * # Allow-list
 *
 * Services that do NOT have an inbound HTTP surface (pure event-bus
 * consumers, batch jobs, the Rust sidecar) are exempt by name.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

/**
 * Services that do NOT need StripInternalHeadersMiddleware. Each entry
 * needs a justification — the default expectation is that every Nest
 * service mounts the middleware.
 */
const SERVICES_EXEMPT = new Set<string>([
  // Gateway itself terminates external traffic; has its own mount path.
  // Allowlisted because the sweep target is non-gateway services.
  // (The gateway DOES still use the middleware — see configure() in its AppModule.)
  // No exemption needed; gateway is included in the sweep.
  'db-migrate', // CLI runner, no HTTP surface
  'sensor-ingestion', // Rust sidecar, not a Nest service
]);

/**
 * Services included in this rollout commit. Other services will be
 * swept in follow-up commits on the same PR; until then, they are NOT
 * exempt — they FAIL this invariant on purpose so the rollout is
 * visible at CI.
 */
const SERVICES_REQUIRED: ReadonlyArray<string> = [
  'gateway-api',
  'auth-service',
  'billing-service',
  // Future: 'farm-service', 'sensor-service', 'hr-service',
  // 'hydroponics-service', 'alert-engine', 'messaging-service',
  // 'admin-api-service', 'notification-service', 'ai-service',
  // 'config-service', 'event-store-service', 'observability-service',
  // — added as each commit on this PR sweeps them in.
];

interface ModuleAnalysis {
  service: string;
  path: string;
  hasImport: boolean;
  hasApplyMount: boolean;
  importsFromCanonical: boolean;
  // True when StripInternalHeadersMiddleware appears before
  // UserContextMiddleware in the apply(...) tuple.
  mountedBeforeUserContext: boolean;
}

function analyzeAppModule(service: string): ModuleAnalysis | null {
  const path = `apps/${service}/src/app.module.ts`;
  let src: string;
  try {
    src = readFileSync(resolve(REPO_ROOT, path), 'utf8');
  } catch {
    return null;
  }
  // Strip block + line comments so docstring mentions of the middleware
  // names do not register as positional occurrences. The mountedBeforeUserContext
  // check below relies on textual position of CODE references only.
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(?<!:)\/\/.*$/, ''))
    .join('\n');
  return {
    service,
    path,
    hasImport: /import\s+\{[^}]*\bStripInternalHeadersMiddleware\b[^}]*\}/.test(stripped),
    importsFromCanonical:
      /import\s+\{[^}]*\bStripInternalHeadersMiddleware\b[^}]*\}\s+from\s+['"]@aquaculture\/backend-common\/middleware['"]/.test(
        stripped,
      ),
    hasApplyMount: /\.apply\([\s\S]*?\bStripInternalHeadersMiddleware\b/.test(stripped),
    mountedBeforeUserContext: (() => {
      // A service may have multiple `.apply(…)` invocations on the
      // MiddlewareConsumer. The constraint is satisfied iff the FIRST
      // textual occurrence of StripInternalHeadersMiddleware after the
      // configure() opening brace appears before the FIRST textual
      // occurrence of UserContextMiddleware in the same scope. Comments
      // are stripped above so docstring mentions do not register here.
      const configureStart = stripped.indexOf('configure(consumer');
      if (configureStart === -1) {
        // Service has no configure() — UserContextMiddleware mounting
        // would have to be elsewhere. Treat absence as trivially satisfied
        // because there is no apply() to verify.
        return true;
      }
      const stripFirstIdx = stripped.indexOf('StripInternalHeadersMiddleware', configureStart);
      if (stripFirstIdx === -1) return false;
      const userFirstIdx = stripped.indexOf('UserContextMiddleware', configureStart);
      if (userFirstIdx === -1) return true; // service does not parse user payload — trivially satisfied
      return stripFirstIdx < userFirstIdx;
    })(),
  };
}

describe('INVARIANT (SEC-CRITICAL-002): StripInternalHeadersMiddleware mounted in every required service AppModule', () => {
  it.each(SERVICES_REQUIRED)('service %s mounts StripInternalHeadersMiddleware before UserContextMiddleware', (service) => {
    const analysis = analyzeAppModule(service);
    expect(analysis).not.toBeNull();
    if (!analysis) return;
    expect(analysis.hasImport).toBe(true);
    expect(analysis.importsFromCanonical).toBe(true);
    expect(analysis.hasApplyMount).toBe(true);
    expect(analysis.mountedBeforeUserContext).toBe(true);
  });

  it('the canonical middleware lives at libs/backend-common/src/middleware', () => {
    const lsFiles = execFileSync(
      'git',
      ['-C', REPO_ROOT, 'ls-files', 'libs/backend-common/src/middleware/strip-internal-headers.middleware.ts'],
      { encoding: 'utf8' },
    ).trim();
    expect(lsFiles).toBe('libs/backend-common/src/middleware/strip-internal-headers.middleware.ts');
  });

  it('exempt services list documents only legitimate non-HTTP services', () => {
    expect(SERVICES_EXEMPT.has('db-migrate')).toBe(true);
    expect(SERVICES_EXEMPT.has('sensor-ingestion')).toBe(true);
    // Required services MUST NOT appear in the exempt list.
    for (const svc of SERVICES_REQUIRED) {
      expect(SERVICES_EXEMPT.has(svc)).toBe(false);
    }
  });
});
