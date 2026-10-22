/**
 * Platform-wide invariant — DATA-HIGH-002 / DATA-HIGH-004 /
 * COMPLIANCE-CRITICAL-003 / CONTRACT-CRITICAL-002:
 *
 * Every event a service constructs (`createBaseEvent(...)`) MUST have a
 * contract: an interface in `libs/event-contracts/src/` that extends
 * BaseEvent and defines that event type.
 *
 * # Why
 *
 * `createBaseEvent` accepts a generic `T extends BaseEvent` and uses
 * `T['eventType']` as the literal type. When callers omit the generic
 * argument (most do — the type-inference path), `T` defaults to
 * `BaseEvent` and `T['eventType']` is the broad `string`, so any string
 * literal compiles cleanly. This was the loophole that let
 * SubscriptionPastDue, SubscriptionExpired, UserDeleted, and several
 * GDPR events ship as raw emits with no contract — the audit captured
 * them as DATA-HIGH-004 + COMPLIANCE-CRITICAL-003 + CONTRACT-CRITICAL-002.
 *
 * # What this test enforces
 *
 * It reads the two owners, never a copy of their rules (SE-3 review round 1,
 * single-owner B1 and B2):
 *
 *   - "who produces event T": `scanEventProducers`
 *     (tools/gates/event-consumer-index.ts) — every call the type checker
 *     resolves to createBaseEvent, its event type folded statically (a const,
 *     an `as const` lookup, a typed field), under apps/, libs/ and
 *     platform/libs/;
 *   - "where event T is defined": `scanEventDefinitions`, the one definition
 *     rule `eventDefinitionsIn` (an interface extending BaseEvent, the
 *     literal values of its own `eventType`).
 *
 *   1. Every folded event type of every producer site is a defined event type.
 *   2. A producer site whose event type does not fold (`unresolved`) fails by
 *      name: no contract can be checked for it.
 *   3. A producer site no application wires (`unattributed`) fails by name:
 *      it is dead code or an attribution gap of the code-fact bridge.
 *
 * Each known gap is listed with the tracked finding that owns it, and a
 * listed gap that no longer exists fails too, so the lists cannot go stale.
 */

import { resolve } from 'node:path';

import {
  type EventProducerIndex,
  scanEventDefinitions,
  scanEventProducers,
} from '../../tools/gates/event-consumer-index';

const REPO_ROOT = resolve(__dirname, '..', '..');
const REVIEW = 'docs/reviews/claude/2026-10-21-aria-quality-learning-program.md';

/** Building the type-checked program over the repository's sources takes seconds. */
const SCAN_TIMEOUT_MS = 180_000;

/**
 * Event types emitted without a contract. Each entry names the tracked finding
 * (owner + deadline) that owns the gap; the entry is removed when the contract
 * lands.
 */
const KNOWN_EXEMPT: ReadonlyMap<string, string> = new Map([
  ['TelemetryCapacityEntitlementChanged', `${REVIEW}#CONTRACT-MEDIUM-013`],
]);

/** Producer sites whose event type does not fold, keyed `<file> <argument text>`. */
const KNOWN_UNRESOLVED: ReadonlyMap<string, string> = new Map([
  [
    'libs/backend-common/src/audit/audit-log.interceptor.ts `audit.${options.action.toLowerCase()}`',
    `${REVIEW}#CONTRACT-MEDIUM-014`,
  ],
  [
    'libs/backend-common/src/security/security-event.service.ts eventTypeName',
    `${REVIEW}#CONTRACT-MEDIUM-014`,
  ],
]);

/** Producer sites no application wires, keyed `<file> <event types>`. */
const KNOWN_UNATTRIBUTED: ReadonlyMap<string, string> = new Map([
  [
    'libs/backend-common/src/database/nats-migration-event-sink.ts SchemaMigrationApplied',
    `${REVIEW}#PLAT-MEDIUM-932`,
  ],
  [
    'libs/backend-common/src/database/nats-migration-event-sink.ts SchemaMigrationFailed',
    `${REVIEW}#PLAT-MEDIUM-932`,
  ],
  [
    'libs/backend-common/src/database/nats-migration-event-sink.ts SchemaMigrationSkipped',
    `${REVIEW}#PLAT-MEDIUM-932`,
  ],
  [
    'libs/backend-common/src/database/nats-migration-event-sink.ts SchemaMigrationStarted',
    `${REVIEW}#PLAT-MEDIUM-932`,
  ],
  [
    'libs/backend-common/src/observability/error-capture.interceptor.ts ServiceErrorCaptured',
    `${REVIEW}#ARIA-MEDIUM-789`,
  ],
]);

/** `path/to/file.ts:12` -> `path/to/file.ts`. */
const fileOf = (site: string): string => site.replace(/:\d+$/, '');

/** Keys found against a known list: the new ones fail by name, and so do listed keys gone stale. */
function unlisted(found: readonly string[], known: ReadonlyMap<string, string>): string[] {
  const present = new Set(found);
  return [
    ...[...present].filter((key) => !known.has(key)).map((key) => `new: ${key}`),
    ...[...known.keys()]
      .filter((key) => !present.has(key))
      .map((key) => `stale (${known.get(key) ?? ''}): ${key}`),
  ].sort();
}

describe('INVARIANT (DATA-HIGH-004): every createBaseEvent emit has a matching contract interface', () => {
  let producers: EventProducerIndex;
  let defined: ReadonlySet<string>;

  beforeAll(() => {
    producers = scanEventProducers(REPO_ROOT);
    defined = new Set(scanEventDefinitions(REPO_ROOT).map((definition) => definition.event_type));
  }, SCAN_TIMEOUT_MS);

  it('every emitted event type is defined by an event-contracts interface', () => {
    expect(producers.sites.length).toBeGreaterThan(100);
    expect(defined.size).toBeGreaterThan(100);

    const orphans = new Map<string, string[]>();
    for (const { site, eventTypes } of producers.sites) {
      for (const eventType of eventTypes ?? []) {
        if (defined.has(eventType) || KNOWN_EXEMPT.has(eventType)) continue;
        orphans.set(eventType, [...(orphans.get(eventType) ?? []), site]);
      }
    }
    const emitted = new Set(producers.sites.flatMap((site) => site.eventTypes ?? []));
    const staleExemptions = [...KNOWN_EXEMPT.keys()].filter(
      (eventType) => defined.has(eventType) || !emitted.has(eventType),
    );

    expect(staleExemptions).toEqual([]);
    expect(
      [...orphans.entries()].map(
        ([eventType, sites]) =>
          `createBaseEvent('${eventType}', …) at ${sites.join(', ')} has no contract: add ` +
          `\`export interface ${eventType}Event extends BaseEvent { eventType: '${eventType}'; … }\` ` +
          'to the appropriate libs/event-contracts/src/*-events.ts file AND to its domain union',
      ),
    ).toEqual([]);
  });

  it('every producer site folds to its event types; an unresolved site fails by name', () => {
    expect(
      unlisted(
        producers.unresolved.map((site) => `${fileOf(site.site)} ${site.form}`),
        KNOWN_UNRESOLVED,
      ),
    ).toEqual([]);
  });

  it('every producer site belongs to an application; an unattributed site fails by name', () => {
    const typesAt = new Map(producers.sites.map((site) => [site.site, site.eventTypes] as const));
    expect(
      unlisted(
        producers.unattributed.map(
          (site) => `${fileOf(site)} ${(typesAt.get(site) ?? []).join(',')}`,
        ),
        KNOWN_UNATTRIBUTED,
      ),
    ).toEqual([]);
  });
});
