import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import { isNatsEventHandler } from './helpers/nats-event-handler';
import { stripComments } from './helpers/ts-source';

/**
 * INVARIANT: event tenancy scope is parsed through the contract, never a
 * hand-rolled UUID guard, and the platform segment is spelled once.
 *
 * SEC-HIGH-057 root cause: `BaseEvent.tenantId` is the routing segment, so a
 * platform-level event (a super admin's password reset) needs a segment too.
 * Three libraries each spelled it, every auth publisher fell back to it with
 * `?? 'system'`, and the notification handler guarded the field with a v4-UUID
 * regex and acknowledged (dropped) anything else — the platform segment
 * included. `@platform/event-contracts` now owns the value
 * (PLATFORM_EVENT_TENANT_ID), the producer derivation (tenantScopeOf) and the
 * consumer parse (eventTenantScope / requireTenantScope). This spec keeps it so:
 *
 *  1. event-bus and outbox alias the contract's constant; no other tenant
 *     segment literal exists.
 *  2. No producer in apps/ spells the platform segment or falls back to it —
 *     createBaseEvent receives a scope (tenantScopeOf) or a real tenant id.
 *  3. The auth-event handler parses through the contract, and the handlers
 *     that still hand-roll a guard are exactly the PLAT-MEDIUM-905 burn-down
 *     list: a file that stops matching must leave the list, and the list
 *     cannot outlive the finding.
 */

const REPO_ROOT = resolve(__dirname, '..', '..');
const APP_SOURCE_ROOTS = ['apps', 'libs/backend-common/src'] as const;
const CONTRACT = 'libs/event-contracts/src/tenant-scope.ts';
const EVENT_BUS_SUBJECT = 'platform/libs/event-bus/src/subjects/tenant-event-subject.ts';
const OUTBOX_ROUTING = 'platform/libs/outbox/src/outbox-routing.ts';
const AUTH_EVENT_HANDLER =
  'apps/notification-service/src/notification/event-handlers/auth-event.handler.ts';

/**
 * PLAT-MEDIUM-905 (owner @okan-wqm, deadline 2026-11-15): NATS handlers that
 * still hand-roll a tenantId UUID guard and return (ack) on a miss. Each is a
 * latent copy of the super-admin drop. The list only shrinks — migrate a
 * handler to requireTenantScope / eventTenantScope and delete its line.
 */
const HAND_ROLLED_GUARD_BURN_DOWN: ReadonlySet<string> = new Set([
  'apps/ai-service/src/conversation/conversation-privacy-event.handler.ts',
  'apps/alert-engine/src/alert/event-handlers/fcr-alert.handler.ts',
  'apps/alert-engine/src/alert/event-handlers/feed-coverage.handler.ts',
  'apps/alert-engine/src/alert/event-handlers/feeding-execution.handler.ts',
  'apps/alert-engine/src/alert/event-handlers/low-stock.handler.ts',
  'apps/alert-engine/src/alert/event-handlers/mortality-alert.handler.ts',
  'apps/alert-engine/src/alert/event-handlers/sensor-reading.handler.ts',
  'apps/alert-engine/src/alert/event-handlers/water-quality-critical.handler.ts',
  'apps/auth-service/src/modules/tenant/event-handlers/tenant-subscription-projection.handler.ts',
  'apps/farm-service/src/events/listeners/farm-stock-projection.listener.ts',
  'apps/farm-service/src/events/listeners/harvest-completed.listener.ts',
  'apps/farm-service/src/events/listeners/mortality-recorded.listener.ts',
  'apps/farm-service/src/events/listeners/sensor-temperature-projection.listener.ts',
  'apps/farm-service/src/task/services/auto-rule-trigger.service.ts',
  'apps/farm-service/src/water-quality/event-handlers/tenant-onboarding.event-handler.ts',
  'apps/notification-service/src/notification/event-handlers/alert-triggered.handler.ts',
  'apps/notification-service/src/notification/event-handlers/billing-event.handler.ts',
  'apps/notification-service/src/notification/event-handlers/device-token-revocation.handler.ts',
  'apps/notification-service/src/notification/event-handlers/feeding-daily-summary.handler.ts',
  'apps/notification-service/src/notification/event-handlers/harvest-regulatory.handler.ts',
  'apps/notification-service/src/notification/event-handlers/messaging-event.handler.ts',
  'apps/notification-service/src/notification/event-handlers/regulatory-report.handler.ts',
  'apps/notification-service/src/notification/event-handlers/task-assigned.handler.ts',
  'apps/notification-service/src/notification/event-handlers/task-event.handler.ts',
  'libs/backend-common/src/database/tenant-schema-cache/tenant-schema-cache-invalidation.subscriber.ts',
]);
const BURN_DOWN_FINDING_ID = 'PLAT-MEDIUM-905';

/** A hand-rolled tenancy guard: a UUID test on the event's tenantId. */
const HAND_ROLLED_GUARD =
  /(?:UUID_REGEX|UUID_RE|UUID_V4[A-Z_]*)\.test\(\s*(?:event|payload)\.tenantId|isValidUUID\(\s*(?:(?:event|payload)\.)?tenantId\s*\)/;

/** A producer spelling or falling back to the platform segment itself. */
const SPELLED_PLATFORM_SEGMENT = [
  /createBaseEvent(?:<[^>]*>)?\(\s*'[A-Za-z]+'\s*,\s*'system'/,
  /\?\?\s*'system'\s*,?\s*\{/, // `x.tenantId ?? 'system', {` — the createBaseEvent fallback shape
  /\?\?\s*OUTBOX_SYSTEM_TENANT_ID\b/,
  /\?\?\s*SYSTEM_EVENT_TENANT_SEGMENT\b/,
];

function readRepoFile(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf-8');
}

function toPosix(p: string): string {
  return p.split(sep).join('/');
}

function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === '__tests__' ||
        entry.name === 'node_modules' ||
        entry.name === 'dist' ||
        entry.name.startsWith('.')
      ) {
        continue;
      }
      files.push(...listSourceFiles(fullPath));
      continue;
    }
    if (
      entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.spec.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.d.ts')
    ) {
      files.push(fullPath);
    }
  }
  return files;
}

interface SourceFile {
  readonly relativePath: string;
  readonly code: string;
}

function appSourceFiles(): SourceFile[] {
  return APP_SOURCE_ROOTS.flatMap((root) =>
    listSourceFiles(resolve(REPO_ROOT, root)).map((file) => ({
      relativePath: toPosix(relative(REPO_ROOT, file)),
      code: stripComments(readFileSync(file, 'utf-8')),
    })),
  );
}

describe('INVARIANT: event tenancy scope is an explicit contract value (SEC-HIGH-057)', () => {
  it('the platform segment is spelled once, in the contract, and aliased by event-bus and outbox', () => {
    const contract = stripComments(readRepoFile(CONTRACT));
    expect(contract).toContain("export const PLATFORM_EVENT_TENANT_ID = 'system' as const;");
    expect(contract).toMatch(/export function tenantScopeOf\(/);
    expect(contract).toMatch(/export function eventTenantScope\(/);
    expect(contract).toMatch(/export function requireTenantScope\(/);

    expect(stripComments(readRepoFile(EVENT_BUS_SUBJECT))).toContain(
      'export const SYSTEM_EVENT_TENANT_SEGMENT = PLATFORM_EVENT_TENANT_ID;',
    );
    expect(stripComments(readRepoFile(OUTBOX_ROUTING))).toContain(
      'export const OUTBOX_SYSTEM_TENANT_ID = PLATFORM_EVENT_TENANT_ID;',
    );

    const otherSpellings = [
      ...listSourceFiles(resolve(REPO_ROOT, 'platform/libs')),
      ...listSourceFiles(resolve(REPO_ROOT, 'libs')),
    ]
      .map((file) => ({
        relativePath: toPosix(relative(REPO_ROOT, file)),
        code: stripComments(readFileSync(file, 'utf-8')),
      }))
      .filter(
        ({ relativePath, code }) =>
          relativePath !== CONTRACT &&
          /[A-Z_]*TENANT[A-Z_]*\s*=\s*'system'\s*as\s*const/.test(code),
      )
      .map(({ relativePath }) => relativePath);
    expect(otherSpellings).toEqual([]);
  });

  it('no producer in apps/ spells the platform segment or falls back to it', () => {
    const offenders = appSourceFiles()
      .filter(({ code }) => SPELLED_PLATFORM_SEGMENT.some((re) => re.test(code)))
      .map(({ relativePath }) => relativePath);
    expect(offenders).toEqual([]);
  });

  it('the auth-event handler parses tenancy through the contract', () => {
    const handler = stripComments(readRepoFile(AUTH_EVENT_HANDLER));
    expect(handler).toContain('eventTenantScope(event)');
    expect(handler).toContain('requireTenantScope(event)');
    expect(handler).not.toMatch(/UUID_REGEX/);
    expect(handler).not.toMatch(HAND_ROLLED_GUARD);
  });

  it('handlers that still hand-roll a tenancy guard are exactly the PLAT-MEDIUM-905 burn-down list', () => {
    const measured = appSourceFiles()
      .filter(({ code }) => isNatsEventHandler(code) && HAND_ROLLED_GUARD.test(code))
      .map(({ relativePath }) => relativePath)
      .sort();

    const stale = [...HAND_ROLLED_GUARD_BURN_DOWN].filter((path) => !measured.includes(path));
    const unlisted = measured.filter((path) => !HAND_ROLLED_GUARD_BURN_DOWN.has(path));

    // A migrated handler must leave the list (the list only shrinks) …
    expect(stale).toEqual([]);
    // … and no new handler may join the pattern.
    expect(unlisted).toEqual([]);
  });

  it('the burn-down list cannot outlive its finding', () => {
    const registry = readRepoFile('docs/reviews/_registry/findings.jsonl')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as { id: string; state: string });
    const finding = registry.find((entry) => entry.id === BURN_DOWN_FINDING_ID);
    expect(finding).toBeDefined();
    if (HAND_ROLLED_GUARD_BURN_DOWN.size > 0) {
      expect(finding?.state).not.toBe('RESOLVED');
    }
  });
});
