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

import { esmExportResult } from './helpers/esm-export';

const REPO_ROOT = process.cwd();
const INVARIANT_DIR = join(REPO_ROOT, 'tests', 'invariants');
const CONFIG_PATH = join(INVARIANT_DIR, 'jest.config.ts');
const DORMANT_MANIFEST_PATH = join(INVARIANT_DIR, 'invariant-reachability.dormant.json');

const REVIEWED_EXCEPTION_LIB = join(REPO_ROOT, 'scripts', 'ci', 'lib', 'reviewed-exception.mjs');

/** Each entry is a reviewed exception `{ owner, reason, expires_on, finding_id }`, keyed by spec file. */
function readDormantManifest(): Record<string, unknown> {
  if (!existsSync(DORMANT_MANIFEST_PATH)) return {};
  return JSON.parse(readFileSync(DORMANT_MANIFEST_PATH, 'utf8')) as Record<string, unknown>;
}

/**
 * Every problem with the waivers, shape and expiry, as scripts/ci/lib/reviewed-exception.mjs
 * states them. The rules are not restated here: the copy this spec used to carry accepted any
 * non-empty reason and finding id (INFRA-LOW-229). Expiry is compared as ISO strings, so a waiver
 * is expired the day after the date it names, everywhere — the assertion that did not exist
 * before 2026-07-31 (see the header).
 */
function waiverProblems(manifest: Record<string, unknown>): string[] {
  const today = new Date().toISOString().slice(0, 10);
  return esmExportResult<string[]>(REVIEWED_EXCEPTION_LIB, 'validateReviewedExceptions', [
    manifest,
    today,
  ]);
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

  it('dormant invariant specs carry owner, reason, expiry and a finding id, and none is past its expiry', () => {
    expect(waiverProblems(readDormantManifest())).toEqual([]);
  });

  it('refuses a waiver the reviewed-exception lib refuses', () => {
    const problems = waiverProblems({
      'x.spec.ts': { owner: 'x', reason: 'tbd', expires_on: '2999-01-01', finding_id: 'TODO' },
    });
    expect(problems.some((problem) => problem.includes('x.spec.ts: reason'))).toBe(true);
    expect(problems.some((problem) => problem.includes('x.spec.ts: finding_id'))).toBe(true);
  });

  it('refuses a waiver whose expiry is not an ISO date, which could never lapse', () => {
    // isReviewedExceptionExpired compares only ISO dates, so a malformed date
    // must be refused as a shape problem or the waiver would never expire.
    const problems = waiverProblems({
      'x.spec.ts': {
        owner: 'x',
        reason: 'a reason long enough to be an argument rather than a label',
        expires_on: '2099-1-1',
        finding_id: 'INFRA-LOW-001',
      },
    });
    expect(problems).toEqual(['x.spec.ts: expires_on must be YYYY-MM-DD']);
  });

  it('refuses a waiver past its expiry', () => {
    const problems = waiverProblems({
      'x.spec.ts': {
        owner: 'x',
        reason: 'a reason long enough to be an argument rather than a label',
        expires_on: '2000-01-01',
        finding_id: 'INFRA-LOW-001',
      },
    });
    expect(problems).toEqual(['x.spec.ts: expired 2000-01-01 (INFRA-LOW-001)']);
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
