/**
 * Query-error-surface invariant — Tier 3, guarding the layer where the
 * information actually gets destroyed.
 *
 * WHY THIS EXISTS. The same defect was found and fixed FIVE separate times in
 * this app before anyone gated it:
 *
 *   HomePage        a failed fetch rendered "0 Fish · 0kg Biomass · Capacity OK"
 *   ReportsPage     a failed fetch rendered "Nothing stocked"
 *   TankDetailPage  a failed fetch rendered "not in your current inventory"
 *   ScanPage        a failed fetch rendered an authorisation claim
 *   StorageHubPage  a failed fetch rendered "0 Items / 0 Low Stock / 0 Today"
 *
 * The first four were screens discarding `isError`. The fifth was worse and is
 * the reason this gate sits here rather than on the screens: `useWarehouseSummary`
 * never EXPOSED `isError` at all, so the screen could not distinguish an outage
 * from an idle warehouse no matter how carefully it was written. The information
 * was destroyed one layer below the bug.
 *
 * So: a hook that wraps `useQuery` and hand-shapes its return MUST carry the
 * error arm out. Hooks that return the raw `UseQueryResult` already do.
 *
 * This is a RATCHET, not a ban — 24 hooks predate it and converting them all at
 * once would be a change nobody could review. It may only shrink. Every hook
 * converted lowers the number; a new hook that swallows its error raises it and
 * fails the build.
 *
 * The permanent fix a converted hook should reach for is src/utils/loadable.ts
 * (`Loadable<T>` makes `data` unreachable without handling the error arm) plus
 * <DataState/>, which renders the three states without letting content appear
 * during a failure.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const HOOKS_DIR = resolve(__dirname, '../hooks');

/**
 * RATCHET BASELINE — hooks that wrap useQuery and do NOT surface an error arm.
 *
 * MEASURED, not estimated. The first draft of this gate guessed 24; the real
 * count is 5, and the deliberate-break check proved the guess made the gate
 * useless: removing isError from useWarehouseSummary took the count to 6 and
 * the gate stayed GREEN. A ratchet with slack is not a ratchet, it is a comment
 * that runs. Always set this to the measured count.
 *
 * Shrink freely; lower this constant in the same commit. It may never grow.
 */
const SWALLOWED_ERROR_BASELINE = 5;

/** A hook "surfaces" its error if any of these appear in its return shape. */
const SURFACES_ERROR = /\bisError\b|\berror\b\s*[,:}]|status:\s*['"]error|Loadable</;

function hookFiles(): string[] {
  return readdirSync(HOOKS_DIR)
    .filter((f) => /^use.*\.tsx?$/.test(f))
    .map((f) => join(HOOKS_DIR, f));
}

/**
 * Hooks that return the raw TanStack result already carry isError by
 * construction — the caller destructures it straight off the query object.
 */
function returnsRawQueryResult(source: string): boolean {
  return /:\s*UseQueryResult|return\s+useQuery\b/.test(source);
}

function swallowingHooks(): string[] {
  const offenders: string[] = [];
  for (const file of hookFiles()) {
    const source = readFileSync(file, 'utf8');
    if (!/\buseQuery\b/.test(source)) continue;
    if (returnsRawQueryResult(source)) continue;
    if (SURFACES_ERROR.test(source)) continue;
    offenders.push(file.replace(`${HOOKS_DIR}/`, ''));
  }
  return offenders;
}

describe('query-error-surface invariant', () => {
  it('ratchets hooks that swallow their query error — shrink only, never grow', () => {
    const offenders = swallowingHooks();
    expect(
      offenders.length,
      `${offenders.length} hooks wrap useQuery without surfacing an error arm, past the ` +
        `frozen baseline of ${SWALLOWED_ERROR_BASELINE}. A hook that drops isError makes the ` +
        'defect unfixable in the screen above it — the screen cannot tell an outage from ' +
        'empty data no matter how it is written. Return the error (or a Loadable from ' +
        `src/utils/loadable.ts).\n\nCurrent:\n${offenders.join('\n')}`,
    ).toBeLessThanOrEqual(SWALLOWED_ERROR_BASELINE);
  });

  it('ships the Loadable primitive the converted hooks are meant to reach for', () => {
    // The ratchet only means something if the correct path exists and is cheap.
    const loadable = readFileSync(resolve(__dirname, '../utils/loadable.ts'), 'utf8');
    expect(loadable).toMatch(/export type Loadable<T>/);
    expect(loadable, 'data must sit on exactly one arm of the union').toMatch(
      /status: 'ready'; data: T/,
    );
    expect(loadable).toMatch(/export function toLoadable/);

    const dataState = readFileSync(resolve(__dirname, '../components/ui/DataState.tsx'), 'utf8');
    expect(dataState).toMatch(/export function DataState/);
    // The children render-prop must only ever receive real data.
    expect(dataState).toMatch(/children: \(data: T\) => ReactNode/);
  });

  it('keeps the error and empty states visually distinct in DataState', () => {
    // "Nothing here" and "could not load" looking alike IS the defect; the
    // component must not collapse them back together.
    const dataState = readFileSync(resolve(__dirname, '../components/ui/DataState.tsx'), 'utf8');
    expect(dataState, 'the error arm must use the error tone').toMatch(/tone="error"/);
    expect(dataState, 'an empty result must be a separate branch').toMatch(
      /isEmpty\(value\.data\)/,
    );
  });
});
