/**
 * usePullToRefresh (FE-MEDIUM-091) — the layout's pull-down gesture fires the
 * refresh only for a pull from the top that passes the threshold, reports the
 * pull while it happens, and stays quiet when disabled or mid-scroll.
 */
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_THRESHOLD_PX,
  MAX_PULL_PX,
  usePullToRefresh,
  type PullTouchEvent,
} from '../usePullToRefresh';

function container(scrollTop = 0): HTMLElement {
  const el = document.createElement('div');
  Object.defineProperty(el, 'scrollTop', { value: scrollTop, configurable: true });
  return el;
}

function touch(target: HTMLElement, clientY: number): PullTouchEvent {
  return { currentTarget: target, touches: [{ clientY }] };
}

describe('usePullToRefresh', () => {
  it('refreshes after a pull from the top that passes the threshold, and reports the pull on the way', async () => {
    let settle: () => void = () => undefined;
    const onRefresh = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );
    const { result } = renderHook(() => usePullToRefresh({ onRefresh }));
    const el = container(0);

    act(() => result.current.handlers.onTouchStart(touch(el, 100)));
    act(() => result.current.handlers.onTouchMove(touch(el, 140)));
    expect(result.current.pullDistance).toBe(40);
    expect(result.current.armed).toBe(false);

    act(() => result.current.handlers.onTouchMove(touch(el, 100 + DEFAULT_THRESHOLD_PX + 10)));
    expect(result.current.armed).toBe(true);

    act(() => result.current.handlers.onTouchEnd());
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(result.current.isRefreshing).toBe(true);
    expect(result.current.pullDistance).toBe(0);

    await act(async () => {
      settle();
      await Promise.resolve();
    });
    expect(result.current.isRefreshing).toBe(false);
  });

  it('caps the reported pull and ignores a short pull', () => {
    const onRefresh = vi.fn(() => Promise.resolve());
    const { result } = renderHook(() => usePullToRefresh({ onRefresh }));
    const el = container(0);

    act(() => result.current.handlers.onTouchStart(touch(el, 0)));
    act(() => result.current.handlers.onTouchMove(touch(el, 500)));
    expect(result.current.pullDistance).toBe(MAX_PULL_PX);

    act(() => result.current.handlers.onTouchCancel());
    expect(result.current.pullDistance).toBe(0);

    act(() => result.current.handlers.onTouchStart(touch(el, 0)));
    act(() => result.current.handlers.onTouchMove(touch(el, DEFAULT_THRESHOLD_PX - 1)));
    act(() => result.current.handlers.onTouchEnd());
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('does nothing when the container is scrolled or the gesture is disabled', () => {
    const onRefresh = vi.fn(() => Promise.resolve());
    const scrolled = renderHook(() => usePullToRefresh({ onRefresh }));
    const el = container(120);
    act(() => scrolled.result.current.handlers.onTouchStart(touch(el, 0)));
    act(() => scrolled.result.current.handlers.onTouchMove(touch(el, 200)));
    expect(scrolled.result.current.pullDistance).toBe(0);
    act(() => scrolled.result.current.handlers.onTouchEnd());

    const disabled = renderHook(() => usePullToRefresh({ onRefresh, enabled: false }));
    const top = container(0);
    act(() => disabled.result.current.handlers.onTouchStart(touch(top, 0)));
    act(() => disabled.result.current.handlers.onTouchMove(touch(top, 200)));
    act(() => disabled.result.current.handlers.onTouchEnd());

    expect(onRefresh).not.toHaveBeenCalled();
  });
});
