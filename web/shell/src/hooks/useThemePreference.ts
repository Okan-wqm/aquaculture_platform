/**
 * useThemePreference — the theme preference (light, dark or system) and the
 * theme it resolves to, read from the one store every surface writes: the
 * attributes the shell's theme util puts on <html> (utils/theme.ts).
 *
 * WHY not component state: the console's user menu and palette change the
 * theme from every page, the settings page included. A copy taken when the
 * page mounted would keep the old option pressed after such a change; the
 * observed attributes cannot disagree with the screen.
 *
 * WHAT: `{ preference, resolved, setPreference }` — setPreference stores the
 * choice and applies it, the same path as useAppliedTheme.
 */
import { useCallback, useSyncExternalStore } from 'react';

import {
  persistThemePreference,
  readAppliedTheme,
  readAppliedThemePreference,
  subscribeToAppliedTheme,
  type ThemePreference,
} from '../utils/theme';

export interface ThemePreferenceState {
  readonly preference: ThemePreference;
  readonly resolved: 'light' | 'dark';
  readonly setPreference: (preference: ThemePreference) => void;
}

function serverPreference(): ThemePreference {
  return 'system';
}

function serverTheme(): 'light' | 'dark' {
  return 'light';
}

export function useThemePreference(): ThemePreferenceState {
  const preference = useSyncExternalStore(
    subscribeToAppliedTheme,
    readAppliedThemePreference,
    serverPreference,
  );
  const resolved = useSyncExternalStore(subscribeToAppliedTheme, readAppliedTheme, serverTheme);
  const setPreference = useCallback((next: ThemePreference): void => {
    persistThemePreference(next);
  }, []);
  return { preference, resolved, setPreference };
}
