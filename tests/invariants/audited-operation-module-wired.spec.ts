/**
 * Platform-wide invariant — AUDITTRAIL-CRITICAL-002:
 *
 * Every Nest service that uses the @AuditedOperation() decorator MUST
 * register AuditedOperationModule.forRoot() in its AppModule imports.
 *
 * # Why
 *
 * The @AuditedOperation() decorator is just metadata. The actual audit-
 * row write happens in AuditedOperationInterceptor, which is registered
 * as APP_INTERCEPTOR by AuditedOperationModule.forRoot(). Without that
 * forRoot() call, the decorator is structurally inert — handlers
 * labelled @AuditedOperation write zero audit rows. The audit captured
 * exactly this regression: 7 billing-service handlers carried the
 * decorator and produced no rows because no service in the fleet
 * imported the module.
 *
 * # What this test enforces
 *
 *   1. Every service in SERVICES_REQUIRED imports
 *      AuditedOperationModule from @aquaculture/backend-common/audit
 *      and calls .forRoot() in its imports list.
 *   2. Any service that has a @AuditedOperation()-decorated handler MUST
 *      appear in SERVICES_REQUIRED. The test scans the apps/ tree for
 *      decorator usage and fails if a service uses the decorator but is
 *      not in the required list.
 *
 * Source-only check; no boot-time discovery. Cheap CI gate.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

/**
 * Services that MUST register AuditedOperationModule.forRoot() in
 * their AppModule imports list. Sweeps add to this list as each
 * service is migrated; the sweep target is "every Nest service".
 */
const SERVICES_REQUIRED: ReadonlyArray<string> = [
  'auth-service',
  'billing-service',
  // W0.J-finalize sweep (this commit):
  'gateway-api',
  'farm-service',
  'sensor-service',
  'hr-service',
  'hydroponics-service',
  'alert-engine',
  'messaging-service',
  'notification-service',
  'ai-service',
  // Future: admin-api-service, config-service, event-store-service,
  // observability-service — internal services with limited surface; their
  // wiring lands in W0.J-followup commits on the same PR.
];

interface ModuleAnalysis {
  service: string;
  hasImport: boolean;
  hasForRootCall: boolean;
}

function analyzeAppModule(service: string): ModuleAnalysis | null {
  const path = `apps/${service}/src/app.module.ts`;
  let src: string;
  try {
    src = readFileSync(resolve(REPO_ROOT, path), 'utf8');
  } catch {
    return null;
  }
  // Strip comments so docstrings mentioning the module don't false-match.
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(?<!:)\/\/.*$/, ''))
    .join('\n');
  return {
    service,
    hasImport:
      /import\s+\{[^}]*\bAuditedOperationModule\b[^}]*\}\s+from\s+['"]@aquaculture\/backend-common\/audit['"]/.test(
        stripped,
      ),
    hasForRootCall: /\bAuditedOperationModule\.forRoot\(\)/.test(stripped),
  };
}

function listDecoratorUsageServices(): Set<string> {
  // Walk apps/<service>/src/**/*.ts (not test files) and collect the
  // service-name prefix of every file containing `@AuditedOperation(`.
  const lsFilesOut = execFileSync(
    'git',
    ['-C', REPO_ROOT, 'ls-files', 'apps/*/src/**/*.ts'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  const files = lsFilesOut
    .split('\n')
    .filter(
      (f) =>
        f.length > 0 &&
        !f.includes('/__tests__/') &&
        !f.endsWith('.spec.ts') &&
        !f.endsWith('.test.ts'),
    );
  const services = new Set<string>();
  for (const rel of files) {
    let src: string;
    try {
      src = readFileSync(resolve(REPO_ROOT, rel), 'utf8');
    } catch {
      continue;
    }
    if (!src.includes('@AuditedOperation(')) continue;
    // Path shape: apps/<service>/src/...
    const match = rel.match(/^apps\/([^/]+)\//);
    const service = match?.[1];
    // ORPHAN-HIGH-507 — guarded, not asserted: a capture the regex matched
    // but did not bind must skip the row, never crash the invariant.
    if (service !== undefined) services.add(service);
  }
  return services;
}

describe('INVARIANT (AUDITTRAIL-CRITICAL-002): AuditedOperationModule.forRoot() wired in every required service', () => {
  it.each(SERVICES_REQUIRED)('service %s registers AuditedOperationModule.forRoot()', (service) => {
    const analysis = analyzeAppModule(service);
    expect(analysis).not.toBeNull();
    if (!analysis) return;
    expect(analysis.hasImport).toBe(true);
    expect(analysis.hasForRootCall).toBe(true);
  });

  it('every service that uses @AuditedOperation() decorator is in SERVICES_REQUIRED', () => {
    const usingDecorator = listDecoratorUsageServices();
    const missing: string[] = [];
    for (const service of usingDecorator) {
      if (!SERVICES_REQUIRED.includes(service)) {
        missing.push(service);
      }
    }
    if (missing.length > 0) {
      throw new Error(
        `Services use @AuditedOperation() but are NOT in SERVICES_REQUIRED ` +
          `(so the decorator is structurally inert there): ${missing.join(', ')}.\n` +
          `Fix: add AuditedOperationModule.forRoot() to each service's AppModule imports ` +
          `AND add the service name to SERVICES_REQUIRED here.`,
      );
    }
  });
});
