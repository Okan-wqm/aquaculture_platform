/**
 * HoldToConfirm specs — the accidental-record guard.
 *
 * This component is the only thing standing between a glove brushing the screen
 * and an irreversible farm record entering the offline queue. Its whole value is
 * that a TAP does nothing, so that is what these specs pin: a quick press, a
 * press that moves off the button, and an unmount mid-hold must all commit
 * nothing. If a refactor ever turns it back into a button, these go red.
 */
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

import { HoldToConfirm } from '../HoldToConfirm';

/** Advances both the fake clock and the Date.now() the component reads. */
function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe('HoldToConfirm', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // The component measures elapsed time with Date.now(), not tick counting,
    // so the mocked clock has to move with the timers.
    vi.setSystemTime(new Date(2026, 0, 1));
  });

  afterEach(() => {
    vi.useRealTimers();
    // The repo's vitest setup does not auto-clean between tests, so an
    // un-unmounted tree from the previous case would make getByRole ambiguous.
    cleanup();
  });

  it('does NOT confirm on a tap', () => {
    const onConfirm = vi.fn();
    render(<HoldToConfirm onConfirm={onConfirm}>Hold to save</HoldToConfirm>);
    const btn = screen.getByRole('button', { name: 'Hold to save' });

    act(() => {
      fireEvent.pointerDown(btn);
    });
    advance(80);
    act(() => {
      fireEvent.pointerUp(btn);
    });
    advance(2000);

    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('confirms once the hold completes', () => {
    const onConfirm = vi.fn();
    render(
      <HoldToConfirm onConfirm={onConfirm} durationMs={700}>
        Hold to save
      </HoldToConfirm>,
    );
    const btn = screen.getByRole('button', { name: 'Hold to save' });

    act(() => {
      fireEvent.pointerDown(btn);
    });
    advance(750);

    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('aborts when the finger slides off the button', () => {
    const onConfirm = vi.fn();
    render(<HoldToConfirm onConfirm={onConfirm}>Hold to save</HoldToConfirm>);
    const btn = screen.getByRole('button', { name: 'Hold to save' });

    act(() => {
      fireEvent.pointerDown(btn);
    });
    advance(300);
    act(() => {
      fireEvent.pointerLeave(btn);
    });
    advance(2000);

    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('does not fire after unmounting mid-hold', () => {
    // The sheet can close under an in-progress hold; a surviving interval would
    // write a record into a tree that no longer exists.
    const onConfirm = vi.fn();
    const { unmount } = render(<HoldToConfirm onConfirm={onConfirm}>Hold to save</HoldToConfirm>);
    const btn = screen.getByRole('button', { name: 'Hold to save' });

    act(() => {
      fireEvent.pointerDown(btn);
    });
    advance(200);
    unmount();
    advance(2000);

    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('never starts a hold while disabled', () => {
    const onConfirm = vi.fn();
    render(
      <HoldToConfirm onConfirm={onConfirm} disabled>
        Hold to save
      </HoldToConfirm>,
    );
    const btn = screen.getByRole('button', { name: 'Hold to save' });

    act(() => {
      fireEvent.pointerDown(btn);
    });
    advance(2000);

    expect(onConfirm).not.toHaveBeenCalled();
    expect(btn).toBeDisabled();
  });
});
