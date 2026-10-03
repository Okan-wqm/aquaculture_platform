/**
 * AppShell — THE seam where the app decides which shell it is wearing.
 *
 * There is exactly one of these, wrapping the whole protected route tree in
 * App.tsx. Nothing else in the app may ask about the viewport to decide what to
 * render: a per-route or per-component check is how "which layout am I in?"
 * becomes a question with fifteen answers that disagree during a rotation.
 *
 * WHY THE CHOICE IS MADE IN JS AND NOT IN CSS. The two shells are different
 * component trees — a thumb dock with a raised scan button versus a top bar with
 * a three-way switcher, a clock and chips. A CSS-only branch would mount both,
 * pay for every hook in both (two alarm polls, two offline-queue subscriptions),
 * and leave the hidden one in the accessibility and tab order. The threshold
 * itself still lives beside the Tailwind `screens` entry that mirrors it, so the
 * number is not duplicated in behaviour — only the mechanism differs.
 *
 * IT RESPONDS TO ROTATION, not just to first render: useIsBoardViewport is a
 * live subscription to the media query (src/hooks/useViewport.ts), so a wall
 * tablet turned on its side, a window dragged wider, or a split-view pane
 * resized swaps the shell in place. Everything the tree needs — router, auth,
 * offline queue, query client — sits ABOVE this component, so the swap keeps the
 * route, the session and the offline queue exactly where they were.
 */
import { type ReactElement, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';

import { MobileLayout } from './MobileLayout';
import { BOARD_PATH, TabletLayout } from './TabletLayout';

import { CriticalAlertBanner } from '@/components/CriticalAlertBanner';
import { useIsBoardViewport } from '@/hooks/useViewport';

/**
 * Routes that own the whole screen on either shell: the camera viewfinder.
 *
 * WHY HERE and not as a full-screen fixed layer the page paints over the dock: a
 * hand-rolled full-screen layer is a dialog in disguise (FE-HIGH-065) — it sits
 * over chrome that is still mounted, still focusable and still reachable by a
 * screen reader. Choosing the chrome per route is the shell's job, so the page
 * renders in flow and the dock is simply not there. The critical-alarm banner
 * is the one piece of chrome that stays: life-safety alarms top every screen,
 * the viewfinder included (MOB-HIGH-006).
 */
const FULL_SCREEN_PATHS: readonly string[] = ['/scan'];

function isFullScreen(pathname: string): boolean {
  return FULL_SCREEN_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

export function AppShell({ children }: { children: ReactNode }): ReactElement {
  const isBoard = useIsBoardViewport();
  const { pathname } = useLocation();

  // THE BOARD ROUTE AND THE VIEWPORT TRAVEL TOGETHER, and both directions are
  // handled here rather than in the route table, because a rotation must not be
  // able to strand the app on a screen the current shell cannot draw.
  //
  //  • On a board viewport, `/` MEANS the board — a cabin tablet that opens on
  //    the phone's Today screen is a phone screen stretched across a wall.
  //  • Below the threshold, `/board` cannot render: a three-column grid on a
  //    390px phone is unusable. A tablet rotated to portrait therefore lands
  //    back on Today, and rotating it back returns it to the board.
  //
  // `replace` on both so a rotation does not push history entries the back
  // button then has to walk through.
  if (isBoard && pathname === '/') {
    return <Navigate to={BOARD_PATH} replace />;
  }
  if (!isBoard && pathname.startsWith(BOARD_PATH)) {
    return <Navigate to="/" replace />;
  }

  if (isFullScreen(pathname)) {
    return (
      <div className="flex flex-col h-full w-full">
        <CriticalAlertBanner />
        {children}
      </div>
    );
  }

  return isBoard ? (
    <TabletLayout>{children}</TabletLayout>
  ) : (
    <MobileLayout>{children}</MobileLayout>
  );
}
