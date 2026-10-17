/**
 * The shell's theme: the stored preference (light, dark or system) and the
 * theme it resolves to, both written on <html> — `data-theme-preference` and
 * `data-theme` (theme.css keys `dark:` on the latter).
 *
 * WHY the root element is the one store: the theme changes from the settings
 * page, the console's user menu and its palette, and the OS colour scheme
 * moves it while the preference is "system". Every surface reads the
 * attributes (subscribeToAppliedTheme) instead of keeping a copy, so none can
 * show a stale choice, and the OS listener (followSystemThemePreference, one
 * per app, installed at boot) reads the preference applied now rather than
 * one captured when it subscribed.
 */
export type ThemePreference = 'light' | 'dark' | 'system';

export const THEME_STORAGE_KEY = 'suderra.theme';

const THEME_VALUES: ThemePreference[] = ['light', 'dark', 'system'];

function isThemePreference(value: string | null | undefined): value is ThemePreference {
  return THEME_VALUES.some((preference) => preference === value);
}

export function getStoredThemePreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (isThemePreference(stored)) {
      return stored;
    }
  } catch {
    // localStorage can be unavailable in private browsing or SSR-like tests.
  }
  return 'system';
}

export function resolveThemePreference(preference: ThemePreference): 'light' | 'dark' {
  if (preference !== 'system') {
    return preference;
  }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyThemePreference(preference: ThemePreference): 'light' | 'dark' {
  const resolved = resolveThemePreference(preference);
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.dataset.themePreference = preference;
  root.style.colorScheme = resolved;
  return resolved;
}

export function persistThemePreference(preference: ThemePreference): 'light' | 'dark' {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // The in-memory selection still applies for this page lifetime.
  }
  return applyThemePreference(preference);
}

/** The preference applied on screen; the stored one before anything is applied. */
export function readAppliedThemePreference(): ThemePreference {
  const applied = document.documentElement.dataset.themePreference;
  return isThemePreference(applied) ? applied : getStoredThemePreference();
}

/** The theme on screen — the resolved `data-theme`. */
export function readAppliedTheme(): 'light' | 'dark' {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

/** Calls `onChange` whenever the applied preference or theme changes, from any surface. */
export function subscribeToAppliedTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'data-theme-preference'],
  });
  return () => observer.disconnect();
}

/**
 * Re-applies "system" when the OS colour scheme changes, while the applied
 * preference is "system" — read at the change, so a choice made since on any
 * surface holds. Installed once at boot; returns the unsubscribe.
 */
export function followSystemThemePreference(): () => void {
  const media = window.matchMedia?.('(prefers-color-scheme: dark)');
  if (!media) {
    return function unsubscribeSystemThemePreference(): void {
      return undefined;
    };
  }

  const listener = (): void => {
    if (readAppliedThemePreference() === 'system') {
      applyThemePreference('system');
    }
  };

  media.addEventListener('change', listener);
  return () => media.removeEventListener('change', listener);
}
