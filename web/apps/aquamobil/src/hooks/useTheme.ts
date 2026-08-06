import { useCallback, useSyncExternalStore } from 'react';

/**
 * useTheme -- the single source of truth for which v4 theme is active.
 *
 * Replaces the old three-way useDarkMode. WHY it had to change: the v4 design
 * ships THREE themes, not two — `night` (dark hall / night shift), `day` (deck
 * glare) and `colour` (colour-coded, gradient ground). A boolean `isDark` cannot
 * express that, so the preference became an enum and the DOM contract became an
 * attribute (`<html data-theme>`) instead of a class.
 *
 * Architecture:
 * - Preference stored in localStorage ('night' | 'day' | 'colour' | 'system')
 * - 'system' follows the OS via matchMedia('prefers-color-scheme: dark'),
 *   resolving to `night` or `day`. The OS has no signal for `colour`, so that
 *   theme is only ever reached by an explicit choice.
 * - Applied as `data-theme` on <html>; the token layer in src/styles/tokens.css
 *   selects the palette off that attribute.
 * - `.dark` is ALSO toggled — a deliberate migration bridge, see applyTheme.
 * - meta[name="theme-color"] tracks the theme so browser chrome matches.
 *
 * The inline script in index.html applies the same rules synchronously to
 * prevent a flash of the wrong theme; keep the two in step.
 */

/** What the user picked. `system` defers to the OS. */
type ThemePreference = 'night' | 'day' | 'colour' | 'system';
/** What is actually painted. `system` has already been resolved away. */
type ResolvedTheme = 'night' | 'day' | 'colour';

interface UseThemeReturn {
  /** The concrete theme being painted right now. */
  theme: ResolvedTheme;
  /** The stored preference, which may be 'system'. */
  preference: ThemePreference;
  /** Set an explicit preference and persist it. */
  setPreference: (pref: ThemePreference) => void;
  /**
   * True when the painted theme is a dark one (night or colour). Kept because
   * a handful of components still need to pick a dark-appropriate asset (e.g.
   * a logo variant) rather than a token.
   */
  isDark: boolean;
}

/** WHY the legacy key is reused: an installed PWA already has a value stored
 *  under it. Migrating in place (see parsePreference) keeps a returning worker
 *  on the theme they chose instead of silently resetting them to system. */
const STORAGE_KEY = 'aquamobil_dark_mode';

/**
 * Browser-chrome colour per theme — matches each theme's --bg-solid so the
 * Android address bar and iOS PWA status bar blend into the app surface.
 */
const THEME_COLOR: Record<ResolvedTheme, string> = {
  night: '#0a1220',
  day: '#f2f5f9',
  colour: '#0b2036',
};

/** Dark-family themes. `day` is the only light one. */
const DARK_THEMES: ReadonlySet<ResolvedTheme> = new Set<ResolvedTheme>(['night', 'colour']);

/**
 * Validates a raw localStorage value, migrating the pre-v4 vocabulary.
 * 'dark' -> 'night' and 'light' -> 'day' so an upgrading install keeps its
 * choice. Anything unrecognised falls back to 'system'.
 */
function parsePreference(raw: string | null): ThemePreference {
  if (raw === 'night' || raw === 'day' || raw === 'colour' || raw === 'system') return raw;
  if (raw === 'dark') return 'night';
  if (raw === 'light') return 'day';
  return 'system';
}

function getSystemPrefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** Collapses 'system' into a concrete theme. */
function resolveTheme(pref: ThemePreference): ResolvedTheme {
  if (pref === 'system') return getSystemPrefersDark() ? 'night' : 'day';
  return pref;
}

/**
 * The ONLY place the theme touches the DOM. Both this module and the
 * index.html anti-FOUC script must apply the same three effects.
 *
 * WHY `.dark` is still toggled alongside `data-theme`: it was a migration
 * bridge for Konsta and the unconverted pages. Both are now gone — Konsta was
 * removed and every page is on the tokens — so the class no longer drives
 * anything in this app. It is kept only because the service worker may still
 * be serving a previously cached bundle to a device that has not updated; a
 * stale chunk that reads `.dark` must not paint itself for the wrong theme.
 * Drop it once the SW rollout window has passed.
 */
function applyTheme(theme: ResolvedTheme): void {
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);
  root.classList.toggle('dark', DARK_THEMES.has(theme));

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.setAttribute('content', THEME_COLOR[theme]);
  }
}

// ---------------------------------------------------------------------------
// External store -- useSyncExternalStore for concurrent-mode safety.
// The OS matchMedia listener and cross-tab storage events both fire outside
// React's lifecycle; this guarantees tear-free reads under concurrent rendering.
// ---------------------------------------------------------------------------

interface ThemeSnapshot {
  theme: ResolvedTheme;
  preference: ThemePreference;
}

const initialPreference = parsePreference(localStorage.getItem(STORAGE_KEY));
let _snapshot: ThemeSnapshot = {
  preference: initialPreference,
  theme: resolveTheme(initialPreference),
};

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): ThemeSnapshot {
  return _snapshot;
}

function emitChange(pref: ThemePreference): void {
  const theme = resolveTheme(pref);
  // Only allocate a new snapshot when something actually changed, so consumers
  // don't re-render on a no-op preference write.
  if (_snapshot.theme === theme && _snapshot.preference === pref) return;
  _snapshot = { theme, preference: pref };
  applyTheme(theme);
  listeners.forEach((fn) => fn());
}

// OS theme changes only matter while the preference is 'system'.
const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
mediaQuery.addEventListener('change', () => {
  if (parsePreference(localStorage.getItem(STORAGE_KEY)) === 'system') {
    emitChange('system');
  }
});

// Cross-tab sync. The 'storage' event fires only for OTHER tabs, never this one.
window.addEventListener('storage', (e: StorageEvent) => {
  if (e.key === STORAGE_KEY) {
    emitChange(parsePreference(e.newValue));
  }
});

// Apply on module init so the DOM is correct before any component mounts. The
// index.html inline script already handled the initial paint; this is the safety
// net for a client-side navigation that loads the app without a document parse.
applyTheme(_snapshot.theme);

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useTheme(): UseThemeReturn {
  const { theme, preference } = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const setPreference = useCallback((pref: ThemePreference) => {
    localStorage.setItem(STORAGE_KEY, pref);
    emitChange(pref);
  }, []);

  return { theme, preference, setPreference, isDark: DARK_THEMES.has(theme) };
}

export type { ThemePreference, ResolvedTheme, UseThemeReturn };
