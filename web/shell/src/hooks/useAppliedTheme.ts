/**
 * useAppliedTheme — the theme on screen, and the way to change it.
 *
 * WHY read from the root element: the theme preference is stored and applied by the
 * shell's theme util (utils/theme.ts) — at boot, from the settings page, from
 * the console's user menu and palette. What is on screen is the resolved
 * `data-theme` it writes on the root element, so the console reads that attribute
 * (observed, not copied into state) and every surface agrees whichever one
 * changed it — the settings page reads the same store (useThemePreference).
 *
 * WHAT: `[theme, setTheme]` — setTheme stores the preference and applies it.
 */
import type { ConsoleTheme } from '@aquaculture/shared-ui';
import { useCallback, useSyncExternalStore } from 'react';

import { persistThemePreference, readAppliedTheme, subscribeToAppliedTheme } from '../utils/theme';

function serverTheme(): ConsoleTheme {
  return 'light';
}

export function useAppliedTheme(): readonly [ConsoleTheme, (theme: ConsoleTheme) => void] {
  const theme = useSyncExternalStore(subscribeToAppliedTheme, readAppliedTheme, serverTheme);
  const setTheme = useCallback((next: ConsoleTheme): void => {
    persistThemePreference(next);
  }, []);
  return [theme, setTheme];
}
