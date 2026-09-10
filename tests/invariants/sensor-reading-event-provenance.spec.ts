/**
 * INVARIANT: a SensorReading event is projected from persisted rows, never
 * assembled from a wire payload (SENSOR-CRITICAL-111).
 *
 * THE DEFECT THIS FREEZES
 *
 * Two of the four producers published the raw MQTT body as the event
 * (`readings: data`, `version: 1`) while writing something else to
 * `sensor_metrics`. Published and stored disagreed on scope AND on value: the
 * row carried `farmId`/`pondId`/`tankId` and the calibrated number, the event
 * carried neither. Downstream, the alert engine's rule query is fail-closed on
 * an absent farm — `rule.farmId IS NULL` — so every farm- or pond-scoped rule
 * was excluded in SQL, silently, while the log truthfully reported the count of
 * the wrong set. A dissolved-oxygen rule on a farm did not fire.
 *
 * WHY A LINT-SHAPED CHECK AND NOT A UNIT TEST
 *
 * Each producer's own spec can only assert what that producer does. The
 * property worth keeping is about the SET of producers: whatever is added next
 * must go through the same projection. That is a statement about the source
 * tree, so it is checked here.
 *
 * WHEN THIS FAILS
 *
 *   1. A publish site was added that mints `SensorReading` with a nested
 *      `readings:` object. Build the body with `projectPersistedReadings` over
 *      the rows you just wrote instead.
 *   2. A publish site emits `version: 1`. v1 is the retired nested shape; the
 *      upcaster exists only for events already on the stream.
 *   3. A new producer file appeared. Add it to PRODUCERS with the same
 *      obligations, or route it through an existing producer.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Every file that mints a `SensorReading`. Kept explicit rather than globbed so
 * that a NEW producer is a deliberate edit here — the finding's blast radius
 * was precisely that two producers drifted while two stayed correct, and
 * nobody had a list to compare.
 */
const PRODUCERS = [
  'apps/sensor-service/src/ingestion/mqtt-listener.service.ts',
  'apps/sensor-service/src/ingestion/data-ingestion.service.ts',
  'apps/sensor-service/src/ingestion/nats-ingestion-consumer.service.ts',
  'apps/sensor-service/src/sensor/services/sensor-ingestion.service.ts',
] as const;

function read(rel: string): string {
  return readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

/**
 * Source files that construct a SensorReading anywhere in the backend.
 * Both call shapes count — the plain `createBaseEvent('SensorReading'` and the
 * generic `createBaseEvent<SensorReadingEvent>('SensorReading'`.
 */
function producersFoundInTree(): string[] {
  const out = execFileSync(
    'grep',
    [
      '-rlE',
      "createBaseEvent(<[^>]+>)?\\('SensorReading'",
      'apps',
      'libs',
      'platform',
      '--include=*.ts',
    ],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  return out
    .split('\n')
    .filter(Boolean)
    .filter((f) => !f.includes('__tests__') && !f.endsWith('.spec.ts'));
}

/**
 * The object literals that BECOME the event: from each `createBaseEvent(…
 * 'SensorReading'` spread to the end of the literal holding it.
 *
 * Scoping matters. `sensor-ingestion.service.ts` legitimately has `readings:`
 * all over it — that is its own `SensorReading` DB row type, whose JSONB column
 * is called `readings`. Only the published body is under this rule, and a
 * file-wide grep would condemn a producer that is already correct.
 */
function eventLiterals(source: string): string[] {
  const literals: string[] = [];
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (!/createBaseEvent(<[^>]+>)?\('SensorReading'/.test(lines[i] ?? '')) continue;
    const indent = (lines[i] ?? '').search(/\S/);
    const window: string[] = [];
    for (let j = i; j < lines.length; j += 1) {
      const line = lines[j] ?? '';
      window.push(line);
      // The literal closes at a `}` / `})` back at or left of the spread's indent.
      if (j > i && /^\s*\}[),;]?\s*$/.test(line) && line.search(/\S/) <= indent - 2) break;
    }
    literals.push(window.join('\n'));
  }
  return literals;
}

describe('INVARIANT: SensorReading provenance (SENSOR-CRITICAL-111)', () => {
  it('the producer list is the set of files that actually mint the event', () => {
    // Both directions: a producer that vanished leaves a stale entry, and a new
    // one that nobody listed is exactly how two of the four drifted unnoticed.
    expect(producersFoundInTree().sort()).toEqual([...PRODUCERS].sort());
  });

  it('no producer publishes a nested `readings` body', () => {
    const offenders: string[] = [];
    for (const rel of PRODUCERS) {
      for (const literal of eventLiterals(read(rel))) {
        for (const match of literal.matchAll(/^\s*readings:\s*[^\n]+$/gm)) {
          offenders.push(`${rel} → ${match[0].trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the literal scan actually finds each producer's event (extractor sanity)", () => {
    // A windowing bug that matched nothing would make the rule above vacuous.
    for (const rel of PRODUCERS) {
      expect(eventLiterals(read(rel)).length).toBeGreaterThan(0);
    }
  });

  it('no producer stamps the retired v1 version', () => {
    const offenders = PRODUCERS.filter((rel) => /\bversion:\s*1\b/.test(read(rel)));
    expect(offenders).toEqual([]);
  });

  it('the two rebuilt producers project from persisted rows', () => {
    // mqtt-listener and data-ingestion are the pair that carried the defect.
    // The other two already built typed events their own way and are covered by
    // their own specs; pinning the call here is what stops a revert.
    for (const rel of [
      'apps/sensor-service/src/ingestion/mqtt-listener.service.ts',
      'apps/sensor-service/src/ingestion/data-ingestion.service.ts',
    ]) {
      expect(read(rel)).toContain('projectPersistedReadings(');
    }
  });

  it('the v1 upcaster resolves keys through the shared vocabulary, not a private map', () => {
    // Its old nine-entry map was keyed by canonical parameter names while the
    // v1 bodies it upcasts are keyed by device channel keys, so almost every
    // replayed reading upcast to nothing — an empty reading the alert engine
    // reads as "returned to normal".
    const upcaster = read('libs/event-contracts/src/upcasters/sensor-reading.upcaster.ts');
    expect(upcaster).toContain('parameterForChannelKey');
    expect(upcaster).not.toMatch(/READING_FIELD_MAP/);
  });

  it('the alert engine does not auto-resolve on a reading that carried no parameters', () => {
    const evaluation = read('apps/alert-engine/src/alert/services/alert-evaluation.service.ts');
    // The guard must sit BEFORE autoResolveIfNormal in the else-chain.
    const guard = evaluation.indexOf('Object.keys(reading.readings).length === 0');
    const autoResolve = evaluation.indexOf('await this.autoResolveIfNormal(reading)');
    expect(guard).toBeGreaterThan(-1);
    expect(autoResolve).toBeGreaterThan(guard);
  });
});
