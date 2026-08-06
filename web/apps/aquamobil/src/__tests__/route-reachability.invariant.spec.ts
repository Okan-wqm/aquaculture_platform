/**
 * Route-reachability invariant — Tier-3 "make it detectable".
 *
 * WHY THIS EXISTS: rewriting HomePage for the v4 design deleted the old gradient
 * header, and the bells lived in it. `/alerts` and `/notifications` kept their
 * routes, kept their guards, kept their pages — and became unreachable, because
 * nothing rendered a control that navigated to them. Nothing failed. The build
 * was green, every test passed, and two features were simply gone.
 *
 * A route with no entry point is dead code that looks alive. This spec asserts
 * that every destination WITHOUT a dock slot is still navigated to from
 * somewhere in the source, so removing the last link to one fails the build
 * instead of quietly retiring a feature.
 *
 * Scope note: only routes a worker reaches by tapping are listed. Routes the
 * dock owns are excluded (the dock is their entry point by construction), as are
 * routes reached only by redirect or by deep link from a push notification.
 *
 * KNOWN BLIND SPOT, stated rather than papered over: the path check is textual,
 * so a route referenced only from a component that is itself rendered nowhere
 * still counts as reachable. That is precisely how the original regression hid —
 * `/notifications` was named inside NotificationBell.tsx while nothing rendered
 * the bell. The second test closes that hole for the two components known to be
 * a route's sole entry point; a general fix needs real render-tree reachability,
 * which is more machinery than this gate is worth. Add a component here whenever
 * one becomes the only way into a destination.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC_DIR = resolve(__dirname, '..');

function walkSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === '__tests__' || entry === 'generated') continue;
      walkSources(full, out);
    } else if (/\.(tsx|ts)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Every source file EXCEPT the router itself, concatenated once.
 *
 * App.tsx is excluded on purpose: it is where routes are DEFINED, so counting it
 * would let a route prove its own reachability. With it out of the corpus, any
 * remaining mention of the path is something that points AT it — a navigate()
 * call, a <Link>, or an entry in a navigation table like Today's shortcut list
 * or the dock's tab list (both of which navigate via a variable, so matching
 * only literal `navigate('/x')` calls would report them as unreachable).
 */
const ALL_SOURCE = walkSources(SRC_DIR)
  .filter((f) => !f.endsWith(`${'/'}App.tsx`))
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n');

/**
 * Destinations that must be reachable by a tap from somewhere in the app.
 *
 * Each entry names the route and what a worker loses if the last link to it is
 * removed — so a future edit that trips this gate can tell whether the removal
 * was intentional.
 */
const MUST_BE_REACHABLE: Array<{ path: string; loses: string }> = [
  { path: '/alerts', loses: 'the alarm history and the ability to acknowledge alarms' },
  { path: '/notifications', loses: 'in-app notifications and their task deep-links' },
  { path: '/account', loses: 'theme, gloves, language, sync, cache and sign-out' },
  { path: '/sync', loses: 'the offline queue contents and manual sync' },
  { path: '/scan', loses: 'resolving a unit by its QR tag' },
  { path: '/units', loses: 'the unit list' },
  { path: '/tasks', loses: 'the full task list beyond the five shown on Today' },
  { path: '/storage', loses: 'warehouse stock operations' },
  { path: '/attendance', loses: 'clocking in and out' },
  { path: '/leave', loses: 'leave balances and requests' },
];

describe('route reachability invariant', () => {
  it.each(MUST_BE_REACHABLE)('$path is navigated to from somewhere', ({ path, loses }) => {
    // Outside the router, the path appearing at all means something points at
    // it. The trailing guard keeps `/task` from matching `/tasks`.
    const quoted = path.replace(/\//g, '\\/');
    const reached = new RegExp(`${quoted}(?:["'\`/?]|\\$\\{)`).test(ALL_SOURCE);

    expect(
      reached,
      `Nothing navigates to ${path}. The route and its page may still exist, but a ` +
        `worker can no longer get there — this silently removes ${loses}. ` +
        'If the removal is intentional, delete the route and page too, and drop this entry.',
    ).toBe(true);
  });

  it('keeps the bells that are the only entry point to alarms and notifications', () => {
    // Named explicitly because these two are components rather than routes, and
    // they were lost exactly this way once: the header that held them was
    // replaced and nothing noticed.
    for (const bell of ['AlertsBell', 'NotificationBell']) {
      const rendered = new RegExp(`<${bell}\\s*/?>`).test(ALL_SOURCE);
      expect(rendered, `<${bell}/> is rendered nowhere — its destination is unreachable`).toBe(
        true,
      );
    }
  });
});
