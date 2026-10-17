/**
 * Command palette hotkey (FE-HIGH-334, design README §8) — ⌘K / Ctrl+K opens
 * the palette from anywhere in the console, and closes it again.
 *
 * WHY a window listener with a guard: the shortcut must work whatever has
 * focus, a field included (that is where a user reaches for it), but a
 * surface that owns Ctrl+K itself — a code editor's chord — handles the key
 * first and prevents its default, and the palette then stays out of its way.
 * Escape is not handled here: the open palette closes through the shared
 * dialog behaviour (Modal/useDialogBehavior), like every other dialog.
 */
import { useEffect, useRef } from 'react';

type HotkeyEvent = Pick<
  KeyboardEvent,
  | 'key'
  | 'metaKey'
  | 'ctrlKey'
  | 'altKey'
  | 'shiftKey'
  | 'repeat'
  | 'isComposing'
  | 'defaultPrevented'
>;

/** ⌘K or Ctrl+K, no other modifier, not a held-down repeat, not mid-IME composition, not already handled. */
export function isCommandPaletteHotkey(event: HotkeyEvent): boolean {
  return (
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey &&
    !event.repeat &&
    !event.isComposing &&
    !event.defaultPrevented &&
    event.key.toLowerCase() === 'k'
  );
}

/**
 * Calls `onToggle` on the shortcut and prevents the browser's own use of it
 * (Ctrl+K focuses the address bar's search). The latest `onToggle` is used,
 * so a caller need not memoise it.
 */
export function useCommandPaletteHotkey(onToggle: () => void, enabled = true): void {
  const toggleRef = useRef(onToggle);
  useEffect(() => {
    toggleRef.current = onToggle;
  }, [onToggle]);

  useEffect(() => {
    if (!enabled) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isCommandPaletteHotkey(event)) return;
      event.preventDefault();
      toggleRef.current();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled]);
}
