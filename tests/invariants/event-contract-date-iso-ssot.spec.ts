/**
 * Platform-wide invariant — ORPHAN-111 (event-contract date convergence):
 *
 * Event contracts carry dates as ISO `string` — the wire shape the JSON schemas
 * validate and the shape `BaseEvent.timestamp` already uses. A `: Date` field on
 * an event interface is a CONTRACT LIE: the TS type misrepresents the serialized
 * wire (the outbox JSON-serialises before validating, so a `Date` is already an
 * ISO string on the wire), and a future pre-serialization validator would reject
 * every such field.
 *
 * # Two locks
 *
 *   1. The canonical `toEventIso()` normaliser exists + is exported — the SINGLE
 *      domain-date → ISO conversion point producers must route through (instead of
 *      scattered `.toISOString()` / ad-hoc `x instanceof Date ? …` checks).
 *   2. A RATCHET on the remaining `: Date` fields across `*-events.ts`. ORPHAN-111
 *      is being converged file-by-file (farm landed first); the count may only
 *      SHRINK. When it reaches 0 this becomes a hard "no Date on any event
 *      contract" assertion (lower BASELINE to 0 with the final slice).
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const EVENTS_DIR = resolve(REPO_ROOT, 'libs/event-contracts/src');

// Baseline 2026-06-26 AFTER the farm + small-files slices converted
// (farm/sensor/alert/ai/notification/task/tenant = 0). Remaining: hr 22 +
// billing 11. Each subsequent slice lowers this; 0 flips it to a hard ban.
const BASELINE_DATE_FIELDS = 33;

describe('INVARIANT (ORPHAN-111): event-contract dates are ISO strings (ratcheted)', () => {
  it('the canonical toEventIso normaliser exists and is exported', () => {
    const base = readFileSync(resolve(EVENTS_DIR, 'base-event.ts'), 'utf8');
    expect(base).toMatch(/export function toEventIso\b/);
    const index = readFileSync(resolve(EVENTS_DIR, 'index.ts'), 'utf8');
    // base-event is re-exported from the barrel (so toEventIso is public).
    expect(index).toMatch(/export \* from '\.\/base-event'/);
  });

  it(`*-events.ts declare at most ${BASELINE_DATE_FIELDS} \`: Date\` fields (shrink-only)`, () => {
    const files = readdirSync(EVENTS_DIR).filter((f) => f.endsWith('-events.ts'));
    const offenders: { file: string; count: number }[] = [];
    let total = 0;
    for (const f of files) {
      const src = readFileSync(resolve(EVENTS_DIR, f), 'utf8');
      const count = (src.match(/\??:\s*Date;/g) ?? []).length;
      if (count > 0) {
        offenders.push({ file: f, count });
        total += count;
      }
    }
    if (total > BASELINE_DATE_FIELDS) {
      throw new Error(
        `Event-contract \`: Date\` fields grew from ${BASELINE_DATE_FIELDS} to ${total}.\n` +
          `Event dates are ISO strings on the wire — type them \`: string\` and\n` +
          `convert producers via toEventIso(). Offenders:\n` +
          offenders.map((o) => `  ${o.file}: ${o.count}`).join('\n'),
      );
    }
    expect(total).toBeLessThanOrEqual(BASELINE_DATE_FIELDS);
    // farm-events is fully converged — it must stay at 0.
    const farm = (readFileSync(resolve(EVENTS_DIR, 'farm-events.ts'), 'utf8').match(/\??:\s*Date;/g) ?? []).length;
    expect(farm).toBe(0);
  });
});
