/**
 * Command palette hotkey and open state (FE-HIGH-334): ⌘K / Ctrl+K toggles the
 * palette from anywhere; opening or closing starts the next session empty.
 */
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { isCommandPaletteHotkey, useCommandPaletteHotkey } from '../CommandPaletteHotkey';
import { useCommandPaletteState } from '../CommandPaletteState';

function press(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  window.dispatchEvent(event);
  return event;
}

describe('isCommandPaletteHotkey', () => {
  it('is Ctrl+K or ⌘K, either case, and nothing else', () => {
    const key = (init: KeyboardEventInit): boolean =>
      isCommandPaletteHotkey(new KeyboardEvent('keydown', init));
    expect(key({ key: 'k', ctrlKey: true })).toBe(true);
    expect(key({ key: 'K', metaKey: true })).toBe(true);
    expect(key({ key: 'k' })).toBe(false);
    expect(key({ key: 'j', ctrlKey: true })).toBe(false);
    expect(key({ key: 'k', ctrlKey: true, shiftKey: true })).toBe(false);
    expect(key({ key: 'k', ctrlKey: true, altKey: true })).toBe(false);
    expect(key({ key: 'k', ctrlKey: true, repeat: true })).toBe(false);
    expect(key({ key: 'k', ctrlKey: true, isComposing: true })).toBe(false);
  });
});

describe('useCommandPaletteHotkey', () => {
  it('toggles on the shortcut and keeps the browser from acting on it', () => {
    const onToggle = vi.fn();
    renderHook(() => useCommandPaletteHotkey(onToggle));

    const event = press({ key: 'k', ctrlKey: true });
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);

    press({ key: 'k' });
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('leaves a shortcut an editor already handled alone', () => {
    const onToggle = vi.fn();
    renderHook(() => useCommandPaletteHotkey(onToggle));
    const editor = document.createElement('textarea');
    document.body.appendChild(editor);
    editor.addEventListener('keydown', (event) => event.preventDefault());

    editor.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }),
    );
    expect(onToggle).not.toHaveBeenCalled();
    editor.remove();
  });

  it('calls the latest handler, listens only while enabled and stops on unmount', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender, unmount } = renderHook(
      ({ handler, enabled }) => useCommandPaletteHotkey(handler, enabled),
      { initialProps: { handler: first, enabled: true } },
    );
    rerender({ handler: second, enabled: true });
    press({ key: 'k', metaKey: true });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);

    rerender({ handler: second, enabled: false });
    press({ key: 'k', metaKey: true });
    expect(second).toHaveBeenCalledTimes(1);

    rerender({ handler: second, enabled: true });
    unmount();
    press({ key: 'k', metaKey: true });
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe('useCommandPaletteState', () => {
  it('opens, closes and toggles, and every session starts with an empty query', () => {
    const { result } = renderHook(() => useCommandPaletteState());
    expect(result.current.open).toBe(false);

    act(() => result.current.openPalette());
    act(() => result.current.setQuery('feed'));
    expect(result.current).toMatchObject({ open: true, query: 'feed' });

    act(() => result.current.close());
    expect(result.current).toMatchObject({ open: false, query: '' });

    act(() => result.current.toggle());
    expect(result.current.open).toBe(true);
    act(() => result.current.setQuery('ali'));
    act(() => result.current.toggle());
    expect(result.current).toMatchObject({ open: false, query: '' });
  });
});
