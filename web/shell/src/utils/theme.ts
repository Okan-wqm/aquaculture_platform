export type ThemePreference = 'light' | 'dark' | 'system';

export const THEME_STORAGE_KEY = 'suderra.theme';

const THEME_VALUES: ThemePreference[] = ['light', 'dark', 'system'];

export function getStoredThemePreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (THEME_VALUES.includes(stored as ThemePreference)) {
      return stored as ThemePreference;
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

export function subscribeToSystemThemePreference(
  getPreference: () => ThemePreference,
  onResolvedThemeChange: (theme: 'light' | 'dark') => void,
): () => void {
  const media = window.matchMedia?.('(prefers-color-scheme: dark)');
  if (!media) {
    return function unsubscribeSystemThemePreference(): void {
      return undefined;
    };
  }

  const listener = (): void => {
    if (getPreference() === 'system') {
      onResolvedThemeChange(applyThemePreference('system'));
    }
  };

  media.addEventListener('change', listener);
  return () => media.removeEventListener('change', listener);
}
