/**
 * Dead in-process @OnEvent listener ratchet (farm-service)
 * ============================================================================
 *
 * Every `@OnEvent(EventNames.X)` subscription declared under
 * `apps/farm-service/src/events/listeners/**` MUST have at least one in-process
 * producer that calls `eventEmitter.emit(EventNames.X)` (or `.emit('<value>')`,
 * the resolved string) somewhere in `apps/farm-service/src/**`. An `@OnEvent`
 * with no matching `emit` is a DEAD LISTENER: NestJS wires the decorator, but
 * the in-process EventEmitter2 never delivers it, so the side effect (alert,
 * status transition, regulatory follow-up, ...) silently never runs.
 *
 * WHY THIS GATE EXISTS (dead-listeners HIGH):
 *   MortalityRecordedListener, HarvestCompletedListener and the
 *   MaintenanceScheduleDue handler subscribed via `@OnEvent` on the in-process
 *   bus, but the real producers (RecordMortalityHandler / CreateHarvestRecordHandler)
 *   publish ONLY through `@platform/outbox` → NATS, emitting the flat
 *   `@platform/event-contracts` events. Nothing ever emitted on the in-process
 *   bus, so high-mortality alerts, the partial-harvest → HARVESTING transition,
 *   and harvest regulatory follow-ups were all dead. The fix migrated them onto
 *   `eventBus.subscribeWildcard(...)`. This ratchet makes the wrong state
 *   (an in-process @OnEvent with no in-process emit) fail CI instead of failing
 *   silently in production.
 *
 * Ratchet, not big-bang:
 *   Two pre-existing dead `@OnEvent` listeners (BatchCreatedListener,
 *   FeedingCompletedListener) have the SAME disease — their producers
 *   (`BatchCreatedEvent`, `FeedingRecordedEvent`) also go through outbox → NATS.
 *   They are tracked separately as ORPHAN-MEDIUM-106
 *   (docs/reviews/orphan-findings.md) — not part of the dead-listeners finding —
 *   and are FROZEN in the baseline below so this gate can land without a
 *   big-bang migration. The
 *   ratchet enforces BOTH directions:
 *     1. No NEW dead @OnEvent — a dead subscription not in the baseline fails.
 *     2. The baseline stays honest — a baseline entry that has since been wired
 *        up or migrated off @OnEvent fails, forcing the list to shrink.
 *   The baseline can therefore only get smaller; it can never be padded.
 *
 * Pure static scan (regex over source) — no NestJS bootstrap, no DB, runs in
 * the farm-service unit jest target on every PR.
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const FARM_SRC = join(__dirname, '..', '..');
const LISTENERS_DIR = join(FARM_SRC, 'events', 'listeners');
const EVENT_TYPES_PATH = join(FARM_SRC, 'events', 'event-types.ts');

/**
 * Pre-existing dead @OnEvent listeners FROZEN at the time this gate was
 * introduced. These are tracked separately as ORPHAN-MEDIUM-106
 * (docs/reviews/orphan-findings.md) for a later subscribeWildcard migration —
 * not part of the dead-listeners finding. Keys are the
 * `EventNames.X` constant identifiers. This list may only SHRINK.
 */
const BASELINE_DEAD_ONEVENT: readonly string[] = ['BATCH_CREATED', 'FEEDING_COMPLETED'];

/**
 * Strip block (`/* *​/`) and line (`//`) comments so docstring mentions of
 * `@OnEvent(...)` (e.g. the migration notes explaining what was removed) are not
 * mistaken for live decorators. Lightweight, sufficient for source scanning —
 * not a full TS parser, but accurate for the decorator/emit patterns scanned.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // line comments (keep `://` in URLs)
}

/** Recursively collect every .ts (non-spec) file under a directory. */
function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      out.push(...collectSourceFiles(full));
    } else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.spec.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.d.ts')
    ) {
      out.push(full);
    }
  }
  return out;
}

/** Resolve EventNames.X constant identifiers to their string literal values. */
function loadEventNameValues(): Map<string, string> {
  const src = readFileSync(EVENT_TYPES_PATH, 'utf8');
  const values = new Map<string, string>();
  // Matches lines like:  MORTALITY_RECORDED: 'batch.mortality.recorded',
  const re = /^\s*([A-Z][A-Z0-9_]+):\s*'([^']+)'/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const key = m[1];
    const value = m[2];
    if (key !== undefined && value !== undefined) {
      values.set(key, value);
    }
  }
  return values;
}

interface OnEventSubscription {
  constName: string; // e.g. MORTALITY_RECORDED
  file: string;
}

function scanOnEventSubscriptions(): OnEventSubscription[] {
  const subs: OnEventSubscription[] = [];
  for (const file of collectSourceFiles(LISTENERS_DIR)) {
    const src = stripComments(readFileSync(file, 'utf8'));
    const re = /@OnEvent\(\s*EventNames\.([A-Z0-9_]+)\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const constName = m[1];
      if (constName !== undefined) {
        subs.push({ constName, file });
      }
    }
  }
  return subs;
}

/**
 * Does any farm-service source file produce this event in-process — either
 * `.emit(EventNames.X)` or `.emit('<resolved value>')`? Listener files are
 * excluded as producers (a listener re-emitting a different event does not make
 * ITS OWN subscription live).
 */
function hasInProcessProducer(
  constName: string,
  value: string | undefined,
  files: string[],
): boolean {
  const emitConst = new RegExp(`\\.emit\\(\\s*EventNames\\.${constName}\\b`);
  const emitLiteral = value
    ? new RegExp(`\\.emit\\(\\s*['"]${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`)
    : null;
  for (const file of files) {
    if (file.startsWith(LISTENERS_DIR)) continue; // listeners are not producers
    const src = stripComments(readFileSync(file, 'utf8'));
    if (emitConst.test(src)) return true;
    if (emitLiteral && emitLiteral.test(src)) return true;
  }
  return false;
}

describe('Dead in-process @OnEvent listener ratchet (farm-service)', () => {
  const eventNameValues = loadEventNameValues();
  const allFarmFiles = collectSourceFiles(FARM_SRC);
  const subscriptions = scanOnEventSubscriptions();

  const deadSubscriptions = subscriptions.filter(
    (s) =>
      !hasInProcessProducer(s.constName, eventNameValues.get(s.constName), allFarmFiles),
  );
  const deadConstNames = new Set(deadSubscriptions.map((s) => s.constName));
  const baselineSet = new Set(BASELINE_DEAD_ONEVENT);

  it('introduces no NEW dead @OnEvent listener (every in-process subscription has ≥1 in-process emit)', () => {
    const offenders = deadSubscriptions
      .filter((s) => !baselineSet.has(s.constName))
      .map((s) => `@OnEvent(EventNames.${s.constName})  (${s.file})`);

    if (offenders.length > 0) {
      throw new Error(
        'Dead in-process @OnEvent listener(s) — NO producer emits the event ' +
          'in-process. Either migrate the listener onto the NATS event bus ' +
          '(eventBus.subscribeWildcard, see FeedingStorageEventHandler) or wire ' +
          'an eventEmitter.emit producer. Do NOT add to the baseline:\n' +
          offenders.map((o) => `  - ${o}`).join('\n'),
      );
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the baseline honest — no entry that has been wired up or migrated off @OnEvent', () => {
    const stale = BASELINE_DEAD_ONEVENT.filter((c) => !deadConstNames.has(c)).map(
      (c) => `EventNames.${c}`,
    );

    if (stale.length > 0) {
      throw new Error(
        `Baseline entr${stale.length === 1 ? 'y is' : 'ies are'} no longer a ` +
          'dead @OnEvent (wired to an emit or migrated to the NATS bus) — ' +
          'remove from BASELINE_DEAD_ONEVENT so the ratchet shrinks:\n' +
          stale.map((s) => `  - ${s}`).join('\n'),
      );
    }
    expect(stale).toEqual([]);
  });

  it('confirms the migrated listeners are OFF @OnEvent (mortality / harvest)', () => {
    // The two finding-scoped listeners must no longer carry ANY @OnEvent.
    const mortalityRaw = readFileSync(
      join(LISTENERS_DIR, 'mortality-recorded.listener.ts'),
      'utf8',
    );
    const harvestRaw = readFileSync(
      join(LISTENERS_DIR, 'harvest-completed.listener.ts'),
      'utf8',
    );
    // Comments are stripped so the migration NOTES (which mention the removed
    // `@OnEvent(...)` decorator) are not mistaken for a live decorator.
    expect(/@OnEvent\(/.test(stripComments(mortalityRaw))).toBe(false);
    expect(/@OnEvent\(/.test(stripComments(harvestRaw))).toBe(false);
    // ...and must subscribe via the NATS bus wildcard instead.
    expect(mortalityRaw).toContain("subscribeWildcard('MortalityRecorded'");
    expect(harvestRaw).toContain("subscribeWildcard('BatchHarvested'");
  });
});
