/**
 * TabletLayout — the v4 shell for the site-cabin control board.
 *
 * WHAT THIS IS FOR. A site runs one tablet on the cabin wall or the desk while
 * the workers are out on the pens with phones. That tablet is a WATCHING
 * surface: it shows what is alarming, what is planned, and what every unit
 * holds. It is deliberately not a second data-entry surface — an entry made
 * from the cabin is an entry made away from the fish, so the board's own footer
 * says so and the dock's raised scan button has no counterpart here.
 *
 * WHY A SEPARATE SHELL RATHER THAN A RESPONSIVE MobileLayout. The two differ in
 * kind, not in size. The phone navigates with a thumb dock of five slots and one
 * screen at a time; the board navigates with a three-way switcher and shows
 * three panes at once. Rendering both trees and hiding one with CSS would run
 * every query and socket twice and leave the hidden shell in the accessibility
 * tree. The choice is therefore made once, in JS, in src/layouts/AppShell.tsx.
 *
 * THE FEEDERS STRIP NOW EXISTS. This header used to record it as impossible,
 * citing ORPHAN-MEDIUM-575 — and that finding's premise was wrong. The VFD
 * surface is rich in apps/sensor-service/src/vfd (devices, bindings, readings,
 * commands); what was missing was any DOCUMENT on this client, so nothing on the
 * server had to change. `src/pages/tablet/panes/DrivesPane.tsx` draws the strip
 * beneath the columns from `vfdStats` + `vfdDevicesByTank`.
 *
 * WHAT IS STILL ABSENT, because the mobile client has no query for it and
 * inventing farm numbers is the worst thing this app can do:
 *   • the drive PERCENTAGE and the hopper LEVEL the design's feeders strip
 *     shows — no brand-neutral percentage field exists (the candidates disagree
 *     between %, Hz and RPM across brands) and `feederSetup` reports the silo's
 *     CAPACITY, never its contents. See the header of src/utils/vfd-drive.ts;
 *   • the SITE + SYSTEM scope picker — there is no site-name query and no
 *     site filter in the API this client speaks, so the scope line below is a
 *     READOUT of what is actually loaded, not a control that pretends to
 *     narrow it;
 *   • report trend charts — no time-series query exists (ORPHAN-MEDIUM-580).
 */
import { clsx } from 'clsx';
import { BarChart3, LayoutGrid, MessageSquare } from 'lucide-react';
import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { AccountAvatar } from '@/components/AccountAvatar';
import { CriticalAlertBanner } from '@/components/CriticalAlertBanner';
import { Chip, SegmentedControl, StatusDot, type SegmentedOption } from '@/components/ui';
import { useAlerts } from '@/hooks/useAlerts';
import { type MobileFeature } from '@/hooks/useMobilePermissions';
import { useOfflineQueue } from '@/hooks/useOfflineQueue';
import { useTanks } from '@/hooks/useTanks';
import type { Tank } from '@/types';
import { useFeatureAccess } from '@/utils/feature-access';
import { toLoadable, type Loadable } from '@/utils/loadable';

/** The board's own route. Exported so the shell switch has one literal to test. */
export const BOARD_PATH = '/board';

type BoardView = 'board' | 'reports' | 'chat';

interface BoardViewOption extends SegmentedOption<BoardView> {
  path: string;
  /** Shown when ANY of these features is reachable. See the note below. */
  features?: MobileFeature[];
}

/**
 * The three views the design gives the board, each on its own `/board/*` route.
 *
 * WHY THEY LIVE UNDER `/board` AND NOT ON THE PHONE'S PATHS. All three are
 * multi-column layouts that only exist above the board threshold. Putting them
 * under the board's own prefix means AppShell's existing rule — below the
 * threshold, anything starting with `/board` redirects to Today — already covers
 * them, so a phone cannot land on a two-pane chat or a two-column report by deep
 * link, by rotation, or by a stale bookmark. That is structural rather than
 * remembered: no new viewport check was added anywhere to get it.
 *
 * The phone's own `/reports` and `/messages` are untouched and still the
 * handheld's destinations; these are additional routes, not replacements.
 *
 * PERMISSIONS: the shape mirrors MobileLayout's dock tabs exactly, including the
 * optional `features` gate, so a future gate applied to a destination reaches
 * BOTH shells. The three carry no gate today for the same reason the dock's tabs
 * do not: the unit, alarm and summary figures are the baseline field capability,
 * `/messages` is open to every mobile role, and the manager-only sections inside
 * Reports self-gate on canReach('reports') exactly as they do on the phone.
 */
const VIEW_OPTIONS: readonly BoardViewOption[] = [
  { value: 'board', label: 'Board', path: BOARD_PATH, icon: <LayoutGrid size={16} /> },
  {
    value: 'reports',
    label: 'Reports',
    path: `${BOARD_PATH}/reports`,
    icon: <BarChart3 size={16} />,
  },
  { value: 'chat', label: 'Chat', path: `${BOARD_PATH}/chat`, icon: <MessageSquare size={16} /> },
];

/**
 * Which segment is lit for a given path.
 *
 * The phone's paths are matched too, and deliberately: the board's Reports view
 * links out to `/reports/:draftId` to review a filing, and a manager on that
 * screen is still in the Reports world — an unlit switcher there would say
 * otherwise. Everything else falls through to the Board world (a unit detail, a
 * task, a form reached from a deep link), which keeps the control honest about
 * where the worker is rather than showing three unlit segments on most screens.
 */
function viewForPath(pathname: string): BoardView {
  if (pathname.startsWith(`${BOARD_PATH}/reports`) || pathname.startsWith('/reports')) {
    return 'reports';
  }
  if (pathname.startsWith(`${BOARD_PATH}/chat`) || pathname.startsWith('/messages')) {
    return 'chat';
  }
  return 'board';
}

/** 24-hour, locale-formatted. A cabin board reading "3:07" is ambiguous. */
const CLOCK_FORMAT = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/**
 * Tick once a SECOND, not once a minute, so the displayed minute flips within a
 * second of the wall clock — a 60s interval drifts by up to a minute, which is
 * visible on a screen somebody is watching all shift. The other 59 ticks are
 * free: the state setter returns the previous string when nothing changed and
 * React bails out of the re-render.
 */
const CLOCK_TICK_MS = 1000;

function useWallClock(): string {
  const [clock, setClock] = useState(() => CLOCK_FORMAT.format(new Date()));

  useEffect(() => {
    // ONE interval for the whole board, cleared on unmount — a wall tablet that
    // rotates to portrait unmounts this shell, and a leaked interval would keep
    // setting state on a dead tree for the rest of the session.
    const id = window.setInterval(() => {
      const next = CLOCK_FORMAT.format(new Date());
      setClock((prev) => (prev === next ? prev : next));
    }, CLOCK_TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  return clock;
}

/**
 * The site + scope line, built from the unit list the phone already loads.
 *
 * The design puts a site and system PICKER here. This client has neither a
 * site-name query nor a site filter, so a picker would be a control that
 * changes nothing over labels nobody can verify. What it shows instead is the
 * truth: how many units are loaded and how many distinct sites they span.
 *
 * A FAILED FETCH SAYS SO. "1 site · 0 units" from a screen that could not reach
 * the farm is the seven-times-found defect this app has a whole type
 * (src/utils/loadable.ts) to prevent — hence the Loadable rather than `data`.
 */
function scopeLine(units: Loadable<Tank[]>): { text: string; unavailable: boolean } {
  if (units.status === 'error') {
    return { text: 'Unit list unavailable — this board may be out of date', unavailable: true };
  }
  if (units.status === 'loading') {
    return { text: 'Loading units…', unavailable: false };
  }
  if (units.data.length === 0) {
    // The fetch SUCCEEDED and there is nothing stocked. Kept separate from the
    // error line above on purpose: "no units" and "we could not ask" are
    // different facts and must never read alike.
    return { text: 'No units in this tenant', unavailable: false };
  }
  const sites = new Set(units.data.map((tank) => tank.siteId ?? 'unassigned')).size;
  return {
    text: `${sites === 1 ? '1 site' : `All ${sites} sites`} · ${units.data.length} units`,
    unavailable: false,
  };
}

export function TabletLayout({ children }: { children: ReactNode }): ReactElement {
  const location = useLocation();
  const navigate = useNavigate();
  const { canReach } = useFeatureAccess();
  const clock = useWallClock();

  // Every figure in the top bar comes from a hook the phone already owns. The
  // board writes no new query.
  const units = toLoadable(useTanks());
  const { unacknowledgedCount, isLoading: alertsLoading, error: alertsError } = useAlerts();
  const { pendingCount, isOnline, isSyncing } = useOfflineQueue();

  const views = VIEW_OPTIONS.filter(
    (view) => !view.features || view.features.some((feature) => canReach(feature)),
  );
  const activeView = viewForPath(location.pathname);
  const scope = scopeLine(units);

  return (
    <div className="flex flex-col h-full w-full overflow-hidden bg-surface-0">
      {/* MOB-HIGH-006: unacknowledged CRITICAL alarms top every screen in both
          shells and stay until acknowledged. On a cabin board this is the whole
          point of the device being on the wall. */}
      <CriticalAlertBanner />

      <header className="shrink-0 bg-surface-1 border-b border-line pt-safe-top">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5">
          <img
            src="/mobile/icons/icon-512x512.svg"
            alt=""
            aria-hidden
            className="w-9 h-9 shrink-0"
          />

          <SegmentedControl
            label="Board view"
            options={views}
            value={activeView}
            onChange={(next) => {
              const target = views.find((view) => view.value === next);
              if (target) navigate(target.path);
            }}
            className="w-[300px] shrink-0"
          />

          {/* Readout, not a picker — see scopeLine(). */}
          <p
            className={clsx(
              'min-w-0 flex-1 truncate text-body',
              scope.unavailable ? 'text-warn' : 'text-ink-2',
            )}
            title={
              scope.unavailable
                ? 'The unit list could not be fetched, so the counts are unknown.'
                : 'This board shows every unit in the tenant — this build has no site or system filter.'
            }
          >
            {scope.text}
          </p>

          <AlarmsChip
            count={unacknowledgedCount}
            isLoading={alertsLoading}
            hasError={alertsError !== null}
            onOpen={() => navigate('/alerts')}
          />

          <QueueChip
            pendingCount={pendingCount}
            isOnline={isOnline}
            isSyncing={isSyncing}
            onOpen={() => navigate('/sync')}
          />

          {/* Deliberately NOT an aria-live region: a screen reader announcing
              the time every minute would bury the alarms it sits next to. It is
              still readable on demand, like any other text. */}
          <time dateTime={clock} className="shrink-0 text-head font-mono tabular-nums text-ink-1">
            {clock}
          </time>

          <AccountAvatar />
        </div>
      </header>

      {/* The board owns its own scrolling per column, so the shell does not
          scroll — a wall display that has scrolled away from its alarms is
          worse than one that shows less. */}
      <main className="flex-1 min-h-0 overflow-hidden">{children}</main>
    </div>
  );
}

/**
 * Alarm count, or the fact that the count is unknown.
 *
 * `useAlerts` surfaces its failure as `error` (a message string) rather than
 * `isError`; either way the rule is the same and it is the rule this app has
 * broken seven times: a failed fetch must never render as "No alarms". That is
 * an all-clear the app has no evidence for, on the surface where an all-clear is
 * most expensive.
 */
function AlarmsChip({
  count,
  isLoading,
  hasError,
  onOpen,
}: {
  count: number;
  isLoading: boolean;
  hasError: boolean;
  onOpen: () => void;
}): ReactElement {
  if (hasError) {
    return (
      <Chip tone="warn" onClick={onOpen} aria-label="Alarms unavailable. Open the alarm list.">
        <StatusDot tone="warn" />
        Alarms unavailable
      </Chip>
    );
  }
  if (isLoading) {
    return (
      <Chip onClick={onOpen} aria-label="Loading alarms. Open the alarm list.">
        Alarms…
      </Chip>
    );
  }
  if (count === 0) {
    return (
      <Chip tone="ok" onClick={onOpen} aria-label="No unacknowledged alarms. Open the alarm list.">
        <StatusDot tone="ok" />
        No alarms
      </Chip>
    );
  }
  return (
    <Chip
      tone="crit"
      onClick={onOpen}
      aria-label={`${count} unacknowledged alarm${count === 1 ? '' : 's'}. Open the alarm list.`}
    >
      <StatusDot tone="crit" live />
      {count} {count === 1 ? 'alarm' : 'alarms'}
    </Chip>
  );
}

/**
 * What this device still owes the farm. On the phone this is a dock badge; on
 * the board it is a chip, because a cabin tablet is where somebody notices that
 * a handheld's queue never drained.
 */
function QueueChip({
  pendingCount,
  isOnline,
  isSyncing,
  onOpen,
}: {
  pendingCount: number;
  isOnline: boolean;
  isSyncing: boolean;
  onOpen: () => void;
}): ReactElement {
  const queued = `${pendingCount} queued`;

  if (!isOnline) {
    return (
      <Chip tone="warn" onClick={onOpen} aria-label={`Offline. ${queued}. Open the sync status.`}>
        <StatusDot tone="warn" />
        Offline · {queued}
      </Chip>
    );
  }
  if (isSyncing) {
    return (
      <Chip tone="accent" onClick={onOpen} aria-label={`Syncing. ${queued}. Open the sync status.`}>
        <StatusDot tone="accent" live />
        Syncing…
      </Chip>
    );
  }
  if (pendingCount > 0) {
    return (
      <Chip tone="accent" onClick={onOpen} aria-label={`${queued}. Open the sync status.`}>
        <StatusDot tone="accent" />
        {queued}
      </Chip>
    );
  }
  return (
    <Chip tone="ok" onClick={onOpen} aria-label="Nothing queued. Open the sync status.">
      <StatusDot tone="ok" />
      Nothing queued
    </Chip>
  );
}
