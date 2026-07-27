/**
 * INVARIANT: every feeding/stock event that has a cross-service consumer is
 * classified in `FARM_SIGNAL_DELIVERY_SEMANTICS`, and every consumer defers
 * to that classification instead of hard-coding "swallow" in a catch block.
 *
 * WHY: the alert-engine consumers all shipped with the same comment —
 * "Swallow so NATS does not redeliver a poison message indefinitely". That is
 * correct for a signal a cron re-derives (tomorrow's coverage sweep re-emits
 * it) and catastrophic for a one-shot state transition: `MealMissed` is
 * emitted once, by the sweep that flips the meal's status, in the same
 * transaction. Nothing re-derives it. Swallowing deletes the fact that a tank
 * went unfed (FARM-MEDIUM-260).
 *
 * The registry makes the distinction a property of the EVENT (tier-1: the
 * `Record` over the consumed-event union means a new event cannot be added to
 * the union without choosing a class). Two holes remain that types cannot see,
 * and this spec closes both (tier-3):
 *
 *   1. A new feeding event declared in `farm-events.ts` and consumed somewhere,
 *      but never added to `ConsumedFarmSignalEvent` — the `Record` stays complete
 *      and the omission is invisible.
 *   2. A consumer that catches, logs and returns without consulting
 *      `requiresDurableDelivery` — the registry says "one_shot" and the code
 *      swallows anyway.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

import {
  FARM_SIGNAL_DELIVERY_SEMANTICS,
  requiresDurableDelivery,
} from '../../libs/event-contracts/src/event-delivery-semantics';

const REPO_ROOT = resolve(__dirname, '..', '..');
const FARM_EVENTS = resolve(REPO_ROOT, 'libs/event-contracts/src/farm-events.ts');

const ALERT_HANDLER_DIR = resolve(
  REPO_ROOT,
  'apps/alert-engine/src/alert/event-handlers',
);

/**
 * Feeding events declared in `farm-events.ts` that legitimately have NO
 * cross-service consumer, so no delivery class is owed. Membership must be
 * justified: an event nobody subscribes to needs no swallow/rethrow decision.
 */
const UNCONSUMED_FEEDING_EVENTS = new Set<string>([
  // Emitted by the ledger and consumed only inside farm-service's own
  // projections; no NATS consumer chooses a policy for it.
  'FeedingRecorded',
  'FeedingRecordUpdated',
  'FeederCalibrationsSaved',
  // Retired v1 inventory contracts — kept for DLQ/replay upcasting only
  // (see feed-inventory-low-to-low-stock-detected.upcaster.ts).
  'FeedInventoryReceived',
  'FeedInventoryAdjusted',
  'FeedInventoryConsumed',
  'FeedInventoryLow',
]);

function feedingEventTypesInContract(): string[] {
  const source = readFileSync(FARM_EVENTS, 'utf-8');
  const matches = source.matchAll(
    /eventType:\s*'((?:Meal|Feed|Feeding|FCR)[A-Za-z]*)';/g,
  );
  return [...new Set([...matches].map((m) => m[1]))];
}

/** Every `.ts` under a directory, skipping tests and node_modules. */
function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      out.push(...tsFiles(full));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Event types every alert-engine handler subscribes to. The literal string in
 * `subscribeWildcard('X', …)` IS the subject discriminator, so scanning for it
 * gives the exact consumed set without running Nest.
 */
function subscribedEventTypes(): Map<string, string[]> {
  const byEventType = new Map<string, string[]>();
  for (const file of tsFiles(ALERT_HANDLER_DIR)) {
    const source = readFileSync(file, 'utf-8');
    const name = file.split(sep).slice(-1)[0];
    // Direct `subscribeWildcard('Foo', …)` plus the array-driven form used by
    // feeding-execution.handler.ts (`const SUBSCRIBED_TYPES = [...]`).
    const direct = [...source.matchAll(/subscribeWildcard(?:<[^>]*>)?\(\s*'([A-Za-z]+)'/g)].map(
      (m) => m[1],
    );
    const listBlock = /SUBSCRIBED_TYPES[^=]*=\s*\[([^\]]*)\]/s.exec(source);
    const listed = listBlock
      ? [...listBlock[1].matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1])
      : [];
    for (const eventType of [...direct, ...listed]) {
      byEventType.set(eventType, [...(byEventType.get(eventType) ?? []), name]);
    }
  }
  return byEventType;
}

describe('INVARIANT: feeding event delivery semantics', () => {
  it('classifies every feeding event in the contract that has a consumer', () => {
    const unclassified = feedingEventTypesInContract().filter(
      (eventType) =>
        !(eventType in FARM_SIGNAL_DELIVERY_SEMANTICS) &&
        !UNCONSUMED_FEEDING_EVENTS.has(eventType),
    );

    expect(unclassified).toEqual([]);
  });

  it('keeps the unconsumed allowlist honest — every entry still exists in the contract', () => {
    const declared = new Set(feedingEventTypesInContract());
    const stale = [...UNCONSUMED_FEEDING_EVENTS].filter((e) => !declared.has(e));

    expect(stale).toEqual([]);
  });

  it('assigns a valid class to every registry entry', () => {
    const invalid = Object.entries(FARM_SIGNAL_DELIVERY_SEMANTICS).filter(
      ([, semantics]) => semantics !== 'reproducible' && semantics !== 'one_shot',
    );

    expect(invalid).toEqual([]);
  });

  it('classifies the one-shot state transitions as one_shot', () => {
    // These are emitted exactly once, in the transaction that changes state.
    // Downgrading any of them to `reproducible` re-opens FARM-MEDIUM-260, so
    // the expectation is spelled out rather than derived from the registry.
    for (const eventType of [
      'MealMissed',
      'MealUnderfed',
      'MealFed',
      'FeedTypeTransitioned',
      'FeedingDailySummary',
      'LowStockDetected',
    ]) {
      expect(requiresDurableDelivery(eventType)).toBe(true);
    }
  });

  it('classifies every event type an alert-engine handler subscribes to', () => {
    const subscribed = subscribedEventTypes();
    expect(subscribed.size).toBeGreaterThan(0);

    const unclassified = [...subscribed.entries()]
      .filter(([eventType]) => !(eventType in FARM_SIGNAL_DELIVERY_SEMANTICS))
      .map(([eventType, files]) => `${eventType} (${files.join(', ')})`);

    expect(unclassified).toEqual([]);
  });

  it('every alert-engine handler defers to requiresDurableDelivery in its catch block', () => {
    expect(statSync(ALERT_HANDLER_DIR).isDirectory()).toBe(true);

    const violations = tsFiles(ALERT_HANDLER_DIR)
      .filter((file) => {
        const source = readFileSync(file, 'utf-8');
        // Only handlers that actually catch need the deferral; one that lets
        // errors propagate is already correct for the strict class.
        return (
          /}\s*catch\s*\(/.test(source) && !/requiresDurableDelivery\s*\(/.test(source)
        );
      })
      .map((file) => file.split(sep).slice(-1)[0]);

    expect(violations).toEqual([]);
  });

  it('no alert-engine event handler still carries the blanket swallow comment', () => {
    const offenders = tsFiles(ALERT_HANDLER_DIR)
      .filter((file) =>
        /Swallow so NATS does not redeliver a poison message indefinitely/.test(
          readFileSync(file, 'utf-8'),
        ),
      )
      .map((file) => file.split(sep).slice(-1)[0]);

    expect(offenders).toEqual([]);
  });
});
