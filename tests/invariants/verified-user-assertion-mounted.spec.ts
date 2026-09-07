/**
 * Platform-wide invariant — SEC-HIGH-156:
 *
 * Every tenant-scoped subgraph AppModule MUST mount VerifiedUserAssertionMiddleware
 * via MiddlewareConsumer.apply(...) in its configure() method, AFTER
 * StripInternalHeadersMiddleware (which sets req.verifiedIdentity) and BEFORE
 * UserContextMiddleware. This makes the gateway-signed x-verified-user-assertion
 * (which binds the user AND the effective tenant into one HMAC-signed blob) the
 * single source of req.user / req.tenantId on every subgraph — instead of the
 * weaker legacy path (raw JWT + a separately-trusted x-tenant-id header).
 *
 * Before this invariant only farm + config mounted the middleware; the other
 * seven tenant-scoped subgraphs leaned on the legacy path, so a compromised
 * intermediary that stripped/forged the tenant header (without the bound
 * assertion) was a larger surface than necessary.
 *
 * # Source-level, same rationale as public-service-edge-hardening.spec.ts:
 * one grep+position pass over every service fires on every PR — fastest
 * feedback for a class of regression that would otherwise ship as a silently
 * weaker trust boundary.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

/**
 * Tenant-scoped subgraphs that receive gateway-federated, tenant-bearing
 * GraphQL and therefore MUST resolve identity from the signed assertion.
 * (gateway-api is the SIGNER; auth-service ISSUES the JWT — neither receives
 * an assertion, so both are intentionally absent.)
 */
const SUBGRAPHS_REQUIRED: ReadonlyArray<string> = [
  'farm-service',
  'config-service',
  'billing-service',
  'sensor-service',
  'hr-service',
  'hydroponics-service',
  'alert-engine',
  'messaging-service',
  'ai-service',
];

interface ModuleAnalysis {
  service: string;
  hasImport: boolean;
  importsFromCanonical: boolean;
  hasApplyMount: boolean;
  /** Strip < VerifiedUserAssertion < UserContext (UserContext optional). */
  orderedCorrectly: boolean;
}

function analyzeAppModule(service: string): ModuleAnalysis | null {
  const path = `apps/${service}/src/app.module.ts`;
  let src: string;
  try {
    src = readFileSync(resolve(REPO_ROOT, path), 'utf8');
  } catch {
    return null;
  }
  // Drop block + line comments so docstring mentions of the middleware names do
  // not register as positional code occurrences.
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(?<!:)\/\/.*$/, ''))
    .join('\n');

  const M = 'VerifiedUserAssertionMiddleware';
  return {
    service,
    hasImport: new RegExp(`import\\s+\\{[^}]*\\b${M}\\b[^}]*\\}`).test(stripped),
    importsFromCanonical: new RegExp(
      `import\\s+\\{[^}]*\\b${M}\\b[^}]*\\}\\s+from\\s+['"]@aquaculture/backend-common/middleware['"]`,
    ).test(stripped),
    hasApplyMount: new RegExp(`\\.apply\\([\\s\\S]*?\\b${M}\\b`).test(stripped),
    orderedCorrectly: (() => {
      const configureStart = stripped.indexOf('configure(consumer');
      if (configureStart === -1) return false;
      const stripIdx = stripped.indexOf('StripInternalHeadersMiddleware', configureStart);
      const assertIdx = stripped.indexOf(M, configureStart);
      if (stripIdx === -1 || assertIdx === -1) return false;
      // Assertion must run AFTER Strip (it reads req.verifiedIdentity Strip sets).
      if (assertIdx < stripIdx) return false;
      // ...and BEFORE UserContext, when the service parses a user payload.
      const userIdx = stripped.indexOf('UserContextMiddleware', configureStart);
      if (userIdx === -1) return true;
      return assertIdx < userIdx;
    })(),
  };
}

describe('INVARIANT (SEC-HIGH-156): VerifiedUserAssertionMiddleware mounted in every tenant-scoped subgraph', () => {
  it.each(SUBGRAPHS_REQUIRED)(
    'subgraph %s mounts VerifiedUserAssertionMiddleware after Strip and before UserContext',
    (service) => {
      const analysis = analyzeAppModule(service);
      expect(analysis).not.toBeNull();
      if (!analysis) return;
      expect(analysis.hasImport).toBe(true);
      expect(analysis.importsFromCanonical).toBe(true);
      expect(analysis.hasApplyMount).toBe(true);
      expect(analysis.orderedCorrectly).toBe(true);
    },
  );

  /**
   * Exclusion-completeness: a subgraph that ALSO serves a non-gateway public
   * HTTP surface (a route reached directly by an edge agent / external system,
   * carrying no gateway service identity) MUST `.exclude()` that surface from
   * VerifiedUserAssertionMiddleware — otherwise it 400s "requires service
   * identity" in production. These are the surfaces a prior revision missed
   * (sensor /install + /api/devices), so they are pinned here. The ai /api/v2/ai
   * REST proxy never existed on the gateway and its exclusion was retired.
   */
  const REQUIRED_EXCLUSIONS: ReadonlyArray<[string, ReadonlyArray<string>]> = [
    ['sensor-service', ['mqtt', 'install', 'api/devices']],
    ['billing-service', ['webhooks']],
  ];

  it.each(REQUIRED_EXCLUSIONS)(
    'subgraph %s excludes its non-gateway public routes from the assertion middleware',
    (service, patterns) => {
      const src = readFileSync(
        resolve(REPO_ROOT, `apps/${service}/src/app.module.ts`),
        'utf8',
      );
      // The exclude must scope the assertion middleware specifically (a 3-way
      // split), so the file carries a `.exclude(` listing each public prefix.
      for (const pattern of patterns) {
        expect(src).toMatch(new RegExp(`\\.exclude\\([^)]*['"]${pattern}['"]`, 's'));
      }
    },
  );

  it('the canonical middleware lives at libs/backend-common/src/middleware', () => {
    const lsFiles = execFileSync(
      'git',
      [
        '-C',
        REPO_ROOT,
        'ls-files',
        'libs/backend-common/src/middleware/verified-user-assertion.middleware.ts',
      ],
      { encoding: 'utf8' },
    ).trim();
    expect(lsFiles).toBe(
      'libs/backend-common/src/middleware/verified-user-assertion.middleware.ts',
    );
  });
});
