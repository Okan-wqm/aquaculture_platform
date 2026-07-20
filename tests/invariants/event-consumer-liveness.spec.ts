import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { PLATFORM_EVENT_REGISTRY } from '../../libs/event-contracts/src/platform-event-registry';

/**
 * Event-consumer liveness invariant (closes ADMIN audit APA-030 —
 * "declared event consumer with no live listener").
 *
 * Root cause it guards: admin-api-service registered TenantOnboardingAckHandler
 * (`@EventPattern('events.*.TenantOnboardingAck')`) and PLATFORM_EVENT_REGISTRY
 * declared admin-api-service as the consumer of that event, but the service's
 * bootstrap never configured a NATS microservice transport. Nest only starts
 * `@EventPattern`/`@MessagePattern` handlers when `connectMicroservice()` +
 * `startAllMicroservices()` run — gated on `natsTransport` in bootstrapService()
 * options — so the handler was silent dead code and the tenant-provisioning
 * saga waited forever for acks that could never arrive.
 *
 * The enforced coherence property is service-agnostic and cannot false-fail:
 *   any apps/<svc> whose src declares a microservice message handler
 *   (@EventPattern | @MessagePattern) MUST configure natsTransport in main.ts.
 *
 * A companion runtime guard (findOrphanedMicroserviceHandlers in
 * libs/backend-common/src/bootstrap/create-service-app.ts) turns the same
 * violation into a cold-start failure.
 */

const REPO_ROOT = resolve(__dirname, '..', '..');
const HANDLER_DECORATOR = /@(?:EventPattern|MessagePattern)\b/;

function listTsSources(absDir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(absDir)) {
    const abs = resolve(absDir, entry);
    if (statSync(abs).isDirectory()) {
      if (entry === '__tests__' || entry === 'test' || entry === 'tests' || entry === 'node_modules') {
        continue;
      }
      out.push(...listTsSources(abs));
      continue;
    }
    if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts') && !entry.endsWith('.test.ts')) {
      out.push(abs);
    }
  }
  return out;
}

function serviceHasMessageHandler(svcDir: string): boolean {
  const srcDir = resolve(svcDir, 'src');
  if (!existsSync(srcDir)) return false;
  return listTsSources(srcDir).some((file) =>
    HANDLER_DECORATOR.test(readFileSync(file, 'utf-8')),
  );
}

function serviceHasNatsTransport(svcDir: string): boolean {
  const mainTs = resolve(svcDir, 'src', 'main.ts');
  if (!existsSync(mainTs)) return false;
  return /\bnatsTransport\s*:/.test(readFileSync(mainTs, 'utf-8'));
}

describe('event-consumer liveness (APA-030)', () => {
  const appsDir = resolve(REPO_ROOT, 'apps');
  const services = readdirSync(appsDir).filter((name) =>
    statSync(resolve(appsDir, name)).isDirectory(),
  );

  it('every service that declares @EventPattern/@MessagePattern handlers configures natsTransport', () => {
    const violations: string[] = [];
    for (const svc of services) {
      const svcDir = resolve(appsDir, svc);
      if (serviceHasMessageHandler(svcDir) && !serviceHasNatsTransport(svcDir)) {
        violations.push(svc);
      }
    }

    expect(violations).toEqual([]);
  });

  it('admin-api-service — the registry-declared TenantOnboardingAck consumer — has a live transport', () => {
    // Anchor the coherence rule to the PLATFORM_EVENT_REGISTRY SSoT: the event
    // whose dead consumer this invariant was written for must stay wired.
    const ackEntry = PLATFORM_EVENT_REGISTRY.TenantOnboardingAck;
    expect(ackEntry.consumers).toContain('admin-api-service');

    const adminDir = resolve(appsDir, 'admin-api-service');
    expect(serviceHasMessageHandler(adminDir)).toBe(true);
    expect(serviceHasNatsTransport(adminDir)).toBe(true);
  });
});
