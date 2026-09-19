/**
 * usePullToRefresh — the app's one pull-down gesture.
 *
 * WHY: `html { overscroll-behavior-y: contain }` switches the browser's own
 * pull-to-refresh off (it would reload the PWA and drop queued work), and
 * exactly one page then re-implemented the gesture by hand for itself
 * (FE-MEDIUM-091). The layout owns it instead: pull down from the top of the
 * content and every active query refetches — the same gesture, the same
 * indicator, on every screen.
 *
 * The gesture reads the scroll container the handlers are attached to and the
 * document: a pull counts only while both are at the top, so an ordinary
 * scroll-up never fires it. React registers touch listeners passively, so
 * nothing is prevented here; overscroll containment keeps the page still.
 */
import { useCallback, useRef, useState, type TouchEvent } from 'react';

export interface PullToRefreshOptions {
  onRefresh: () => Promise<unknown>;
  /** Off while offline — a pull then does nothing. */
  enabled?: boolean;
  /** Finger travel in px that arms the refresh. */
  threshold?: number;
}

export interface PullToRefreshHandlers {
  onTouchStart: (event: TouchEvent<HTMLElement>) => void;
  onTouchMove: (event: TouchEvent<HTMLElement>) => void;
  onTouchEnd: () => void;
  onTouchCancel: () => void;
}

export interface PullToRefreshState {
  /** Finger travel so far, capped for the indicator; 0 when idle. */
  pullDistance: number;
  /** Past the threshold — releasing refreshes. */
  armed: boolean;
  isRefreshing: boolean;
  handlers: PullToRefreshHandlers;
}

/** The indicator never grows past this, however far the finger travels. */
export const MAX_PULL_PX = 96;
export const DEFAULT_THRESHOLD_PX = 72;

function atTop(container: HTMLElement): boolean {
  const documentTop = document.scrollingElement?.scrollTop ?? 0;
  return container.scrollTop <= 0 && documentTop <= 0;
}

export function usePullToRefresh({
  onRefresh,
  enabled = true,
  threshold = DEFAULT_THRESHOLD_PX,
}: PullToRefreshOptions): PullToRefreshState {
  const startY = useRef<number | null>(null);
  const travel = useRef(0);
  const [pullDistance, setPullDistance] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const reset = useCallback(() => {
    startY.current = null;
    travel.current = 0;
    setPullDistance(0);
  }, []);

  const onTouchStart = useCallback(
    (event: TouchEvent<HTMLElement>) => {
      const touch = event.touches[0];
      if (!enabled || isRefreshing || !touch || !atTop(event.currentTarget)) {
        startY.current = null;
        return;
      }
      startY.current = touch.clientY;
    },
    [enabled, isRefreshing],
  );

  const onTouchMove = useCallback(
    (event: TouchEvent<HTMLElement>) => {
      const touch = event.touches[0];
      if (startY.current === null || !touch) return;
      if (!atTop(event.currentTarget)) {
        reset();
        return;
      }
      travel.current = Math.max(0, Math.min(touch.clientY - startY.current, MAX_PULL_PX));
      setPullDistance(travel.current);
    },
    [reset],
  );

  const onTouchEnd = useCallback(() => {
    const armed = startY.current !== null && travel.current >= threshold;
    reset();
    if (!armed || !enabled || isRefreshing) return;
    setIsRefreshing(true);
    // The gesture is fire-and-forget: the refetch's own error state is the
    // surface for failures, the indicator only needs to know when it ended.
    void onRefresh().finally(() => setIsRefreshing(false));
  }, [enabled, isRefreshing, onRefresh, reset, threshold]);

  return {
    pullDistance,
    armed: pullDistance >= threshold,
    isRefreshing,
    handlers: { onTouchStart, onTouchMove, onTouchEnd, onTouchCancel: reset },
  };
}
