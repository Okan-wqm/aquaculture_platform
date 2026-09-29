/**
 * INVARIANT — one identity per farm condition (ALERT-MEDIUM-006).
 *
 * `signalKey()` in `libs/event-contracts/src/signal-key.ts` is the only builder
 * of a farm condition's key: the alert-engine incident (`signal_key`), the
 * auto-rule task subject, the AI tracking suggestion and finding all derive it
 * from the same subject, so equal conditions get equal keys by construction.
 *
 * Tier 1 does most of the work: the key is the BRANDED `SignalKey`, and the
 * incident lifecycle (`FarmSignalIncidentSpec.signalKey`) accepts nothing else,
 * so a hand-spelled string does not compile. This spec closes the holes the
 * compiler cannot see:
 *
 *   1. No `as SignalKey` cast anywhere but the builder — a cast would mint a
 *      key the builder never validated.
 *   2. No hand-spelled key literal (a string or template starting with a
 *      builder prefix) in production source outside the builder — a literal
 *      used where a plain string is accepted (a query, a log correlation, a
 *      future task key) would silently drift from the builder's format.
 *   3. Parity: every alert-engine service that opens a farm-signal incident
 *      derives the key with `signalKey(`, and none of the retired
 *      `system:<signal>:` synthetic ids survives.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { SIGNAL_KEY_PREFIXES } from '../../libs/event-contracts/src/signal-key';
import { stripComments } from './helpers/ts-source';

const REPO_ROOT = resolve(__dirname, '..', '..');
const BUILDER = 'libs/event-contracts/src/signal-key.ts';

function productionSources(): string[] {
  return execFileSync('git', ['-C', REPO_ROOT, 'ls-files', 'apps', 'libs', 'platform', 'web'], {
    encoding: 'utf8',
  })
    .split('\n')
    .filter(
      (file) =>
        /\.(ts|tsx)$/.test(file) &&
        !/\.(spec|test|e2e-spec)\.tsx?$/.test(file) &&
        !file.includes('/__tests__/') &&
        !file.includes('/__mocks__/') &&
        !file.includes('/migrations/') &&
        file !== BUILDER,
    );
}

function codeOf(file: string): string {
  return stripComments(readFileSync(resolve(REPO_ROOT, file), 'utf8'));
}

describe('INVARIANT: signalKey() is the only builder of a farm condition key', () => {
  const files = productionSources();
  const sources = new Map(files.map((file) => [file, codeOf(file)]));

  it('scans a real tree', () => {
    expect(files.length).toBeGreaterThan(1000);
    expect(files).toContain('apps/alert-engine/src/alert/services/farm-signal-incident.service.ts');
  });

  it('never casts to SignalKey outside the builder', () => {
    const offenders = [...sources]
      .filter(([, code]) => /\bas\s+SignalKey\b/.test(code))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });

  it('never hand-spells a signal key literal outside the builder', () => {
    // A quote or backtick immediately followed by a builder prefix and a colon.
    const prefixes = Object.values(SIGNAL_KEY_PREFIXES).map((p) => p.replace(/[-]/g, '\\-'));
    const literal = new RegExp(`['"\`](?:${prefixes.join('|')}):`);
    const offenders = [...sources].filter(([, code]) => literal.test(code)).map(([file]) => file);
    expect(offenders).toEqual([]);
  });

  it('keys every alert-engine farm-signal incident with signalKey() and no retired system: id', () => {
    const services = files.filter((file) =>
      file.startsWith('apps/alert-engine/src/alert/services/'),
    );
    // Openers of a FARM-signal incident (sensor-rule incidents keep their rule id).
    const openers = services.filter((file) =>
      /farmSignalIncident\.ensureIncident\(/.test(sources.get(file) ?? ''),
    );
    expect(openers.length).toBeGreaterThanOrEqual(6);
    for (const file of openers) {
      expect({ file, usesBuilder: /\bsignalKey\(/.test(sources.get(file) ?? '') }).toEqual({
        file,
        usesBuilder: true,
      });
    }
    const retired =
      /`system:(water-quality|mortality|low-stock|fcr|feed-stockout|feed-transition|meal-|unfed-unit|feeding-window)/;
    const leftovers = services.filter((file) => retired.test(sources.get(file) ?? ''));
    expect(leftovers).toEqual([]);
  });
});
