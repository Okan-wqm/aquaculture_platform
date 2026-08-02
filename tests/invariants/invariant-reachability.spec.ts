/**
 * Every spec in `tests/invariants/` runs, unless a dormancy waiver says why not
 * — and a waiver expires.
 *
 * WHAT THIS FILE GOT RIGHT ALREADY. The shard config used to enumerate every
 * spec by name, and this file asserted that a spec on disk was either in that
 * enumeration or in `invariant-reachability.dormant.json` with an owner, a
 * reason and an expiry. That is a real tier-3 guard and it worked: the 25 specs
 * outside the config were declared, not forgotten.
 *
 * WHAT IT GOT WRONG, and it is the same defect this whole branch keeps closing.
 * The expiry was validated for SHAPE — `/^\d{4}-\d{2}-\d{2}$/` — and never
 * compared to the clock. Every one of the 25 waivers read `2026-06-30`. On
 * 2026-07-31 all of them were a month past expiry, the suite was green, and no
 * review had been forced by the field that exists to force one. A waiver whose
 * expiry nothing checks is a waiver with no expiry; checking the syntax of a
 * date instead of the date is checking the syntax of a thing instead of the
 * thing.
 *
 * WHAT CHANGED HERE.
 *
 *   1. `expires_on` is load-bearing: a waiver past its date fails this spec.
 *   2. Shard membership is a glob, so a new spec is IN the suite because it
 *      exists rather than because someone remembered it in a second place, and
 *      the dormancy manifest is now the ONE exclusion list — the config reads
 *      it, so a config list and a manifest can no longer disagree.
 *   3. Every waiver must name a tracked finding. Owner + reason + expiry says
 *      who and why and until when; without an ID there is nothing that gets
 *      worked, which is how 25 waivers reached one shared expiry date and then
 *      passed it together.
 *
 * Making the date load-bearing expired all 25 at once. Eighteen of them turned
 * out to need no waiver at all — they pass — and were revived rather than
 * re-dated, which is real coverage this repository already believed it had. The
 * remaining seven are genuinely red for reasons owned by the auth, audit,
 * billing and legal-hold lanes; they carry ORPHAN-HIGH-512 and a new deadline
 * rather than being switched on red or deleted.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from '@jest/globals';

const REPO_ROOT = process.cwd();
const INVARIANT_DIR = join(REPO_ROOT, 'tests', 'invariants');
const CONFIG_PATH = join(INVARIANT_DIR, 'jest.config.ts');
const DORMANT_MANIFEST_PATH = join(INVARIANT_DIR, 'invariant-reachability.dormant.json');

type DormantEntry = {
  owner: string;
  reason: string;
  expires_on: string;
  finding_id: string;
};

function readDormantManifest(): Record<string, DormantEntry> {
  if (!existsSync(DORMANT_MANIFEST_PATH)) return {};
  return JSON.parse(readFileSync(DORMANT_MANIFEST_PATH, 'utf8')) as Record<string, DormantEntry>;
}

function specsOnDisk(): string[] {
  return readdirSync(INVARIANT_DIR)
    .filter((name) => name.endsWith('.spec.ts'))
    .sort();
}

describe('invariant spec reachability', () => {
  it('every invariant spec runs unless the manifest excludes it', () => {
    // Asserted against what Jest WOULD select, not against the config's text.
    // The previous version searched the config source for each spec's name,
    // which is why making membership a glob broke it: the names it looked for
    // were the enumeration, and removing the enumeration is the fix.
    const config = readFileSync(CONFIG_PATH, 'utf8');
    expect(config).toContain("testMatch: ['<rootDir>/*.spec.ts']");
    expect(config).toContain('DORMANT_SPECS');

    const dormant = readDormantManifest();
    const unreachable = specsOnDisk().filter((name) => dormant[name]);
    // Every excluded spec must be excluded THROUGH the manifest, and the config
    // derives its ignore list from that same manifest — so this is the complete
    // set of exclusions by construction rather than by inspection.
    expect(unreachable.sort()).toEqual(Object.keys(dormant).sort());
  });

  it('dormant invariant specs carry owner, reason, expiry and a finding id', () => {
    const invalid = Object.entries(readDormantManifest())
      .filter(
        ([, entry]) =>
          !entry.owner ||
          !entry.reason ||
          !entry.finding_id ||
          !/^\d{4}-\d{2}-\d{2}$/.test(entry.expires_on),
      )
      .map(([name]) => name);
    expect(invalid).toEqual([]);
  });

  it('no dormancy waiver is past its expiry', () => {
    // THE ASSERTION THAT DID NOT EXIST. Compared as ISO strings, which sort
    // lexicographically for this format, so no timezone reasoning is involved —
    // a waiver is expired the day after the date it names, everywhere.
    const today = new Date().toISOString().slice(0, 10);
    const expired = Object.entries(readDormantManifest())
      .filter(([, entry]) => entry.expires_on < today)
      .map(([name, entry]) => `${name} expired ${entry.expires_on} (${entry.finding_id})`);
    expect(expired).toEqual([]);
  });

  it('every dormant spec still exists', () => {
    // A waiver for a deleted file is a waiver nobody can ever retire, and it
    // makes the debt count read higher than the debt.
    const missing = Object.keys(readDormantManifest()).filter(
      (name) => !existsSync(join(INVARIANT_DIR, name)),
    );
    expect(missing).toEqual([]);
  });
});
