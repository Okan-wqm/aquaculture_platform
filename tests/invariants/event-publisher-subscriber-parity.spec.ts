/**
 * Platform-wide invariant — event publisher/subscriber parity (APA-201).
 *
 * Every platform event type that ANY service SUBSCRIBES to (via
 * `eventBus.subscribeWildcard('X')`, `eventBus.subscribe('X')`, or
 * `@EventPattern('events.*.X')`) MUST have at least one PUBLISHER somewhere in
 * the repo that constructs it through `createBaseEvent('X')`.
 *
 * # Why
 *
 * APA-201 was an instance of the "subscribed-but-never-published" dead-wiring
 * class: notification-service subscribed to `AnnouncementPublished`, but no
 * service ever emitted it — so publishing an announcement flipped a status flag
 * and delivered nothing. Nothing structurally detected that a consumer was
 * waiting on an event no producer sends. This invariant catches the whole class:
 * a live subscription with no live publisher fails CI.
 *
 * # Scan robustness
 *
 * - The "universe" of platform events is derived from the `eventType: 'X'`
 *   discriminants declared in libs/event-contracts, so subscriptions to
 *   framework/example strings (e.g. an `@EventPattern('events.*.MyEventType')`
 *   doc snippet) are ignored — only real contract events are enforced.
 * - Publisher detection is multi-line aware (`createBaseEvent<T>(\n  'X'`) and
 *   ignores dynamic re-publishers (`createBaseEvent(event.eventType, …)`), which
 *   forward an existing event rather than originate a new one.
 * - `.subscribe(fn)` (RxJS) never matches — a string-literal first argument is
 *   required, and the captured name must be a known contract event.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCAN_ROOTS = ['apps', 'platform', 'libs'];
const CONTRACT_DIR = resolve(REPO_ROOT, 'libs', 'event-contracts', 'src');

/**
 * Subscribed contract events that have NO publisher yet — pre-existing,
 * out-of-scope debt tracked elsewhere. Each entry MUST cite its tracking
 * reason. Removing an entry re-locks the gap; adding one requires the gap to be
 * genuinely out of the current change's scope.
 */
const KNOWN_UNPUBLISHED_SUBSCRIPTIONS: ReadonlyMap<string, string> = new Map([
  [
    'BulkThreadsCreated',
    'APA-213 — the admin bulk-broadcast messaging silo (admin-api MessagingService) ' +
      'has not been migrated onto the event bus; notification-service subscribes but ' +
      'no producer emits it yet. Out of scope for APA-201 (announcements only).',
  ],
  [
    'InvoiceOverdue',
    'Billing pre-existing debt — notification-service billing-event.handler subscribes, ' +
      'but no billing producer emits InvoiceOverdue yet. Out of scope for APA-201.',
  ],
]);

function walkTsFiles(absDir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(absDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = resolve(absDir, entry);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (
        entry === 'node_modules' ||
        entry === '__tests__' ||
        entry === 'dist' ||
        entry === '.archive' ||
        entry === 'test' ||
        entry === 'tests'
      ) {
        continue;
      }
      walkTsFiles(abs, out);
      continue;
    }
    if (
      entry.endsWith('.ts') &&
      !entry.endsWith('.spec.ts') &&
      !entry.endsWith('.test.ts') &&
      !entry.endsWith('.d.ts')
    ) {
      out.push(abs);
    }
  }
}

function collectSourceFiles(): string[] {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) {
    walkTsFiles(resolve(REPO_ROOT, root), files);
  }
  return files;
}

/** Contract event universe: `eventType: 'X'` discriminants in event-contracts. */
function collectContractEventTypes(): Set<string> {
  const files: string[] = [];
  walkTsFiles(CONTRACT_DIR, files);
  const types = new Set<string>();
  const re = /eventType\s*:\s*['"]([A-Z][A-Za-z0-9]+)['"]/g;
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const eventType = m[1];
      if (eventType !== undefined) types.add(eventType);
    }
  }
  return types;
}

interface Subscription {
  eventType: string;
  file: string;
}

function collectSubscriptions(files: string[], contractEvents: Set<string>): Subscription[] {
  const subs: Subscription[] = [];
  const patterns = [
    /subscribe(?:Wildcard)?\s*\(\s*['"]([A-Z][A-Za-z0-9]+)['"]/g,
    /@EventPattern\s*\(\s*['"]events\.[^.'"]*\.([A-Za-z0-9]+)['"]/g,
  ];
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(src)) !== null) {
        const eventType = m[1];
        if (eventType === undefined) continue;
        // Only enforce real platform contract events — ignore framework/example
        // strings and RxJS `.subscribe('...')` on non-event observables.
        if (contractEvents.has(eventType)) {
          subs.push({ eventType, file: file.replace(`${REPO_ROOT}/`, '') });
        }
      }
    }
  }
  return subs;
}

function collectPublishers(files: string[]): Set<string> {
  const published = new Set<string>();
  // Multi-line aware: createBaseEvent, optional <TypeArg>, then a string literal
  // as the FIRST argument. A variable first arg (createBaseEvent(event.eventType))
  // is a forwarder, not an originator, and is intentionally NOT matched.
  const re = /createBaseEvent\s*(?:<[^>]*>)?\s*\(\s*['"]([A-Z][A-Za-z0-9]+)['"]/g;
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const eventType = m[1];
      if (eventType !== undefined) published.add(eventType);
    }
  }
  return published;
}

describe('INVARIANT (APA-201): every subscribed contract event has a publisher', () => {
  const files = collectSourceFiles();
  const contractEvents = collectContractEventTypes();
  const subscriptions = collectSubscriptions(files, contractEvents);
  const publishers = collectPublishers(files);
  const subscribedTypes = new Set(subscriptions.map((s) => s.eventType));

  it('discovers the contract-event universe, subscriptions, and publishers', () => {
    expect(contractEvents.size).toBeGreaterThan(0);
    expect(subscribedTypes.size).toBeGreaterThan(0);
    expect(publishers.size).toBeGreaterThan(0);
    // Anchor: AnnouncementPublished is subscribed (notification-service).
    expect(subscribedTypes.has('AnnouncementPublished')).toBe(true);
  });

  it('every subscribed contract event has at least one createBaseEvent publisher', () => {
    const violations: string[] = [];
    for (const eventType of Array.from(subscribedTypes).sort()) {
      if (publishers.has(eventType)) continue;
      if (KNOWN_UNPUBLISHED_SUBSCRIPTIONS.has(eventType)) continue;
      const where = subscriptions
        .filter((s) => s.eventType === eventType)
        .map((s) => s.file);
      violations.push(
        `  ${eventType} — subscribed in [${Array.from(new Set(where)).join(', ')}] ` +
          `but no createBaseEvent('${eventType}') publisher exists anywhere in the repo`,
      );
    }
    if (violations.length > 0) {
      throw new Error(
        `${violations.length} subscribed event type(s) have no publisher ` +
          `(dead subscribed-but-never-published wiring):\n${violations.join('\n')}\n\n` +
          `Emit the event through createBaseEvent('<Type>') from the owning service, ` +
          `or (only if genuinely out of scope + tracked) add it to ` +
          `KNOWN_UNPUBLISHED_SUBSCRIPTIONS with a reason.`,
      );
    }
  });

  it('AnnouncementPublished is published (APA-201 stays closed) and is not allowlisted', () => {
    expect(KNOWN_UNPUBLISHED_SUBSCRIPTIONS.has('AnnouncementPublished')).toBe(false);
    expect(publishers.has('AnnouncementPublished')).toBe(true);
  });

  it('every allowlisted gap is still a real subscribed-without-publisher gap (no stale entries)', () => {
    const stale: string[] = [];
    for (const [eventType] of KNOWN_UNPUBLISHED_SUBSCRIPTIONS) {
      const stillGap = subscribedTypes.has(eventType) && !publishers.has(eventType);
      if (!stillGap) stale.push(eventType);
    }
    expect(stale).toEqual([]);
  });
});
