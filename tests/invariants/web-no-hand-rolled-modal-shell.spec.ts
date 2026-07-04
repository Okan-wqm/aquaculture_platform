/**
 * Farm-module UI must use the shared `@aquaculture/shared-ui` `Modal` primitive,
 * never a hand-rolled `fixed inset-0` backdrop-overlay modal shell.
 *
 * WHY: a hand-rolled shell renders the dimming backdrop as a `position: fixed`
 * element and the panel as a non-positioned (or transform-only) in-flow box.
 * CSS paint order then draws the backdrop ON TOP of the panel, so the form opens
 * *behind* the dark overlay and is unreachable (the /sites/tanks New-Batch bug,
 * FARM-HIGH-129). The shared `Modal` portals to document.body and positions its
 * panel `relative`, making that whole bug class impossible — and it brings
 * focus-trap, Escape, scroll-lock and role=dialog for free. It is the SSoT modal
 * primitive; hand-rolling one is banned.
 *
 * RATCHET: KNOWN_OFFENDERS is the frozen burn-down list. It may only SHRINK:
 *   - a NEW hand-rolled modal backdrop → not in the set → FAILS (no regression);
 *   - a baselined file that no longer offends → the ratchet FAILS until it is
 *     REMOVED from the set (a review-visible edit), so the baseline can't go stale.
 * The farm-module migration to the shared Modal drained this set to empty.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCAN_ROOT = 'web/modules/farm-module/src';
const SKIP_DIRS = new Set(['node_modules', 'dist', '__tests__', 'test', '__mocks__']);

// A modal backdrop overlay: a full-viewport `fixed inset-0` element carrying a
// translucent DARK dim (the tell of a modal scrim). Light dimmers (bg-white/…)
// used by loading spinners are intentionally NOT matched.
const DARK_DIM = 'bg-(?:black|gray-400|gray-500|gray-600|gray-700|gray-800|gray-900|slate-800|slate-900|neutral-800|neutral-900|zinc-800|zinc-900)/\\d';
const BACKDROP_FWD = new RegExp(`fixed inset-0[^"'\`\\n]*${DARK_DIM}`);
const BACKDROP_REV = new RegExp(`${DARK_DIM}[^"'\`\\n]*fixed inset-0`);

/** Hand-rolled modal backdrops still present. Migration drained this to empty. */
const KNOWN_OFFENDERS = new Set<string>([]);

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      out.push(...walk(full));
    } else if (/\.tsx$/.test(entry) && !/\.(spec|test)\.tsx$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

function hasHandRolledBackdrop(source: string): boolean {
  return source
    .split('\n')
    .some((line) => BACKDROP_FWD.test(line) || BACKDROP_REV.test(line));
}

const files = walk(resolve(REPO_ROOT, SCAN_ROOT));
const offenders = files
  .filter((f) => hasHandRolledBackdrop(readFileSync(f, 'utf8')))
  .map((f) => f.replace(`${REPO_ROOT}/`, ''));

describe('farm-module modals use the shared Modal primitive, not a hand-rolled backdrop', () => {
  it('scans a non-empty file surface', () => {
    expect(files.length).toBeGreaterThan(50); // sanity: the scan actually ran
  });

  it('no NEW hand-rolled modal backdrop outside the frozen burn-down list', () => {
    const unexpected = offenders.filter((f) => !KNOWN_OFFENDERS.has(f));
    expect(unexpected).toEqual([]);
  });

  it('every baselined offender still offends (ratchet cannot go stale)', () => {
    const fixed = [...KNOWN_OFFENDERS].filter((f) => {
      try {
        return !hasHandRolledBackdrop(readFileSync(resolve(REPO_ROOT, f), 'utf8'));
      } catch {
        return true; // moved/deleted → must be removed from the set
      }
    });
    expect(fixed).toEqual([]);
  });
});
