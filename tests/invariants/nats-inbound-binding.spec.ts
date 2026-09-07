/**
 * An inbound NATS handler is actually bound (ADMIN-HIGH-014, ADR-0018).
 *
 * The platform has two inbound mechanisms and they bind through different
 * machinery:
 *
 *   - `@EventPattern` / `@MessagePattern` bind through a Nest microservice
 *     transport, which exists only if the service's `main.ts` passes
 *     `natsTransport` to `bootstrapService`. Without it Nest attaches no
 *     server strategy and the decorated methods are never called. Nothing
 *     warns: the class constructs, the module boots, the subject is silent.
 *   - `@SubscribeTo` binds through `EventHandlerRegistryModule`, which scans
 *     `DiscoveryService.getProviders()` and is fail-closed — a subscription it
 *     cannot establish throws out of `onModuleInit`.
 *
 * admin-api-service carried three `@EventPattern` handlers and no
 * `natsTransport`. The security-signal projection that ADMIN-HIGH-014's fix
 * depends on, and the tenant-onboarding ACK ledger, were both dead on arrival.
 * The defect is invisible in review because each half is correct on its own;
 * only the pairing is wrong. So the pairing is what this spec checks:
 *
 *   1. A service that declares `@EventPattern`/`@MessagePattern` declares
 *      `natsTransport` in its `main.ts`.
 *   2. A class that declares `@SubscribeTo` is `@Injectable`, is registered
 *      under `providers` (never `controllers`, which the registry cannot see),
 *      and its service imports `EventHandlerRegistryModule`.
 *   3. The two mechanisms are never mixed inside one class.
 *
 * Finding: docs/reviews/admin-expert/2026-09-05-superadmin-audit.md#ADMIN-HIGH-014
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

/** Source with comments stripped — a docblock naming a decorator is not one. */
function code(file: string): string {
  return readFileSync(join(REPO_ROOT, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function listFiles(...globs: string[]): string[] {
  return execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '--', ...globs], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

const SERVICE_SOURCES = listFiles('apps/*/src/**/*.ts').filter(
  (file) => !/\.(?:spec|test)\.ts$/.test(file) && !file.includes('__tests__'),
);

function serviceOf(file: string): string {
  return file.split('/')[1] as string;
}

/** Every service directory that has a main.ts — the deployable set. */
const SERVICES = [...new Set(listFiles('apps/*/src/main.ts').map(serviceOf))].sort();

const EVENT_PATTERN_RE = /@(?:EventPattern|MessagePattern)\(/;
const SUBSCRIBE_TO_RE = /@SubscribeTo\(/;

function filesMatching(re: RegExp): string[] {
  return SERVICE_SOURCES.filter((file) => re.test(code(file)));
}

describe('INVARIANT (ADMIN-HIGH-014): an inbound NATS handler is bound to a transport that exists', () => {
  const eventPatternFiles = filesMatching(EVENT_PATTERN_RE);
  const subscribeToFiles = filesMatching(SUBSCRIBE_TO_RE);

  it('sees both mechanisms in the tree', () => {
    // A rename or a moved decorator would otherwise make every case vacuous.
    expect(SERVICES.length).toBeGreaterThanOrEqual(10);
    expect(subscribeToFiles.length).toBeGreaterThan(0);
  });

  it('every service using @EventPattern declares natsTransport in main.ts', () => {
    const offenders = [...new Set(eventPatternFiles.map(serviceOf))]
      .filter((service) => !/\bnatsTransport\s*:/.test(code(`apps/${service}/src/main.ts`)))
      .map(
        (service) =>
          `${service}: @EventPattern in ${eventPatternFiles
            .filter((file) => serviceOf(file) === service)
            .map((file) => basename(file))
            .join(', ')} but main.ts passes no natsTransport`,
      );
    expect(offenders).toEqual([]);
  });

  it('every service using @SubscribeTo imports the fail-closed EventHandlerRegistryModule', () => {
    // Without the registry the decorator is inert metadata — the same silent
    // no-binding, one mechanism over.
    const offenders = [...new Set(subscribeToFiles.map(serviceOf))].filter((service) => {
      const appModule = `apps/${service}/src/app.module.ts`;
      if (!existsSync(join(REPO_ROOT, appModule))) return true;
      return !/\bEventHandlerRegistryModule\b/.test(code(appModule));
    });
    expect(offenders).toEqual([]);
  });

  it('every @SubscribeTo class is an @Injectable provider, never a controller', () => {
    // EventHandlerRegistryModule scans getProviders(); a @Controller is not one.
    const offenders: string[] = [];
    for (const file of subscribeToFiles) {
      const source = code(file);
      if (!/@Injectable\(/.test(source)) {
        offenders.push(`${file}: @SubscribeTo class is not @Injectable`);
      }
      if (/@Controller\(/.test(source)) {
        offenders.push(
          `${file}: @SubscribeTo class is a @Controller, which the registry cannot see`,
        );
      }

      const className = /export class (\w+)/.exec(source)?.[1];
      if (!className) continue;
      const registrations = listFiles(`apps/${serviceOf(file)}/src/**/*.module.ts`).filter(
        (module) => new RegExp(`\\b${className}\\b`).test(code(module)),
      );
      if (registrations.length === 0) {
        offenders.push(`${className}: declares @SubscribeTo and is registered in no module`);
      }
      for (const module of registrations) {
        const source = code(module);
        const controllers = /controllers:\s*\[([\s\S]*?)\]/.exec(source)?.[1] ?? '';
        if (new RegExp(`\\b${className}\\b`).test(controllers)) {
          offenders.push(`${module}: registers ${className} under controllers, not providers`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no class mixes @EventPattern and @SubscribeTo', () => {
    // The two have different delivery guarantees (core NATS at-most-once vs a
    // durable JetStream consumer). One class answering to both is a handler
    // whose retry semantics depend on which decorator fired.
    const mixed = SERVICE_SOURCES.filter((file) => {
      const source = code(file);
      return EVENT_PATTERN_RE.test(source) && SUBSCRIBE_TO_RE.test(source);
    });
    expect(mixed).toEqual([]);
  });
});
