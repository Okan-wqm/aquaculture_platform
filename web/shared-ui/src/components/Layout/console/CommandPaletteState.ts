/**
 * Command palette open state (FE-HIGH-334, design README §8: "open resets the
 * query").
 *
 * WHY a hook: the palette's query is controlled — the shell needs it to match
 * people and devices (usePaletteSources) — so the reset belongs to whoever
 * owns the state. Owning it here makes the reset automatic: every way to open
 * or close (trigger, ⌘K, Escape, a run) goes through these setters, and each
 * starts the next session with an empty query.
 */
import { useCallback, useMemo, useState } from 'react';

export interface CommandPaletteState {
  readonly open: boolean;
  readonly query: string;
  readonly setQuery: (query: string) => void;
  readonly openPalette: () => void;
  readonly close: () => void;
  /** What ⌘K does (useCommandPaletteHotkey): open when closed, close when open. */
  readonly toggle: () => void;
}

export function useCommandPaletteState(): CommandPaletteState {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const openPalette = useCallback((): void => {
    setQuery('');
    setOpen(true);
  }, []);
  const close = useCallback((): void => {
    setQuery('');
    setOpen(false);
  }, []);
  const toggle = useCallback((): void => {
    setQuery('');
    setOpen((wasOpen) => !wasOpen);
  }, []);

  // One object per state change, so a context carrying it re-renders its
  // consumers only when the palette actually opens, closes or is typed in.
  return useMemo(
    (): CommandPaletteState => ({ open, query, setQuery, openPalette, close, toggle }),
    [open, query, openPalette, close, toggle],
  );
}
