/**
 * The error store has a producer, and every service is wired into it
 * (ADMIN-HIGH-014, OBS-CRITICAL-003).
 *
 * `admin.error_groups` / `admin.error_occurrences` had an ErrorTrackingPage, a
 * dashboard, four read endpoints and a 1,000-line service behind them, and not
 * one row had ever been written. The only entry point to
 * `ErrorTrackingService.reportError` was `POST /system/errors/report`, behind
 * the global `PlatformAdminGuard` plus `@RequiresCapability('security-ops')` —
 * a service that has just thrown cannot authenticate as a platform admin, so
 * that route was never reachable by the only caller that would have wanted it.
 *
 * The ingress that replaced it is easy to disable by accident and impossible to
 * notice: an interceptor dropped from the bootstrap factory, a service added
 * without the NATS publish grant, or a consumer that stops subscribing all
 * produce the same symptom the finding describes — a page reading an empty
 * table with no error anywhere. So each link is pinned here:
 *
 *   1. the bootstrap factory registers capture for EVERY service, so no service
 *      can opt out by omission;
 *   2. every service that can publish has the ACL grant to do it — a missing
 *      grant means NATS silently rejects that service's defects;
 *   3. admin-api subscribes and has a handler bound to the subject;
 *   4. the unreachable HTTP ingress does not come back.
 *
 * Finding: docs/reviews/admin-expert/2026-09-05-superadmin-audit.md#ADMIN-HIGH-014
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import * as yaml from 'js-yaml';

const REPO_ROOT = resolve(__dirname, '..', '..');
const FACTORY = 'libs/backend-common/src/bootstrap/create-service-app.ts';
const INTERCEPTOR = 'libs/backend-common/src/observability/error-capture.interceptor.ts';
const CONSUMER =
  'apps/admin-api-service/src/system-management/handlers/error-capture-projection.handler.ts';
const SUBJECT = 'events.*.ServiceErrorCaptured';

interface AclService {
  name: string;
  application?: string;
  publish?: string[];
  subscribe?: string[];
}

function read(file: string): string {
  return readFileSync(join(REPO_ROOT, file), 'utf8');
}

/** Source with comments stripped — a docblock naming a subject is not a grant. */
function code(file: string): string {
  return read(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function listFiles(...globs: string[]): string[] {
  return execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '--', ...globs], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

function aclServices(): AclService[] {
  const doc = yaml.load(read('infrastructure/nats/services.yaml')) as { services: AclService[] };
  return doc.services;
}

/**
 * Services whose defects the interceptor can actually publish: they boot through
 * the factory and they registered an event bus for it to publish on.
 */
function capturingApps(): string[] {
  return listFiles('apps/*/src/main.ts')
    .map((file) => file.split('/')[1] as string)
    .filter((app) => {
      const main = code(`apps/${app}/src/main.ts`);
      if (!/\bbootstrapService\s*\(/.test(main)) return false;
      // `EventBusModule` is @Global(), so importing it in ANY module of the
      // service publishes EVENT_BUS to the root injector — observability-service
      // imports it in two feature modules and never in app.module.ts.
      // `*` in a git pathspec matches across `/`, and `**/` requires at least
      // one directory level — which would skip `src/app.module.ts` itself.
      return listFiles(`apps/${app}/src/*.module.ts`).some((module) =>
        /\bEventBusModule\b/.test(code(module)),
      );
    })
    .sort();
}

describe('INVARIANT (ADMIN-HIGH-014): the error store has a producer, fleet-wide', () => {
  it('the bootstrap factory registers error capture for every service', () => {
    // Per-service wiring was never an option: 7 of the 15 services register no
    // exception filter at all and the other 8 are divergent hand-copies, so
    // anything hooked to "the service's filter" leaves half the fleet invisible.
    const factory = code(FACTORY);
    expect(factory).toMatch(/useGlobalInterceptors\(\s*\n?\s*new ErrorCaptureInterceptor\(/);
    expect(existsSync(join(REPO_ROOT, INTERCEPTOR))).toBe(true);
  });

  it('capture re-throws, so it can never change what a client sees', () => {
    // An interceptor that swallowed would turn a 500 into a 200. The unit suite
    // proves the behaviour; this pins the shape against a careless edit.
    const interceptor = code(INTERCEPTOR);
    expect(interceptor).toMatch(/catchError\(/);
    expect(interceptor).toMatch(/return throwError\(\(\) => error\)/);
  });

  it('sees the fleet', () => {
    // A rename that broke the scan would make every case below vacuous.
    const apps = capturingApps();
    expect(apps.length).toBeGreaterThanOrEqual(12);
    expect(apps).toContain('admin-api-service');
  });

  it('every capturing service has the NATS publish grant — without it the defects are rejected', () => {
    const services = aclServices();
    const byApp = new Map(services.map((service) => [service.application, service]));

    const missing = capturingApps().filter((app) => {
      const service = byApp.get(app);
      return !service || !(service.publish ?? []).includes(SUBJECT);
    });
    expect(missing).toEqual([]);
  });

  it('no service holds a publish grant it cannot use', () => {
    // A grant for a service that does not boot through the factory, or has no
    // event bus, is an ACL claiming coverage the platform does not have.
    const capturing = new Set(capturingApps());
    const stale = aclServices()
      .filter((service) => (service.publish ?? []).includes(SUBJECT))
      .map((service) => service.application ?? service.name)
      .filter((app) => !capturing.has(app));
    expect(stale).toEqual([]);
  });

  it('admin-api subscribes to the subject and binds a handler to it', () => {
    const admin = aclServices().find((service) => service.application === 'admin-api-service');
    expect(admin).toBeDefined();
    expect(admin?.subscribe ?? []).toContain(SUBJECT);

    const consumer = code(CONSUMER);
    expect(consumer).toMatch(/@SubscribeTo\(/);
    expect(consumer).toContain(SUBJECT);
    // A provider, not a controller: the registry discovers over getProviders().
    expect(consumer).toMatch(/@Injectable\(/);
  });

  it('the unreachable HTTP ingress does not come back', () => {
    // It was gated by `@RequiresCapability('security-ops')` behind the global
    // platform-admin guard. A crashing service cannot satisfy either, which is
    // why the table stayed empty for the life of the feature.
    const controller = code(
      'apps/admin-api-service/src/system-management/controllers/error-tracking.controller.ts',
    );
    expect(controller).not.toMatch(/@Post\(\s*'report'\s*\)/);
  });

  it('reportError is reached only from the consumer', () => {
    // Any other caller is a second ingress with its own auth story and its own
    // volume, which is how the store ends up with two disagreeing producers.
    const callers = listFiles('apps/*/src/*.ts')
      .filter((file) => !/\.(?:spec|test)\.ts$/.test(file) && !file.includes('__tests__'))
      .filter((file) => /\.reportError\(/.test(code(file)));
    expect(callers).toEqual([CONSUMER]);
  });
});
