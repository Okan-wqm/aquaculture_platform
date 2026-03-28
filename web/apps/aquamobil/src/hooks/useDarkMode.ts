import { useCallback, useSyncExternalStore } from 'react';

/**
 * useDarkMode -- Manages dark mode preference with three-way toggle.
 *
 * Architecture:
 * - Preference stored in localStorage ('light' | 'dark' | 'system')
 * - 'system' follows OS preference via matchMedia('prefers-color-scheme: dark')
 * - Applied by toggling 'dark' class on document.documentElement (Tailwind darkMode: 'class')
 * - Also updates meta[name="theme-color"] for browser chrome theming
 *
 * Enterprise pattern: Material Design 3 three-way toggle (Light/Dark/System).
 * The inline script in index.html prevents flash of wrong theme on load.
 */

type DarkModePreference = 'light' | 'dark' | 'system';

interface UseDarkModeReturn {
  /** Whether the resolved theme is currently dark (accounts for 'system' matching OS) */
  isDark: boolean;
  /** The stored preference: 'light', 'dark', or 'system' */
  preference: DarkModePreference;
  /** Set an explicit preference and persist it */
  setPreference: (pref: DarkModePreference) => void;
  /** Cycle through: light -> dark -> system -> light */
  toggle: () => void;
}

const STORAGE_KEY = 'aquamobil_dark_mode';

// WHY: Light theme-color matches the ocean-600 brand blue, dark uses gray-950 (#030712)
// to match the Tailwind dark surface. These colors appear in the mobile browser chrome
// (address bar on Android, status bar tint on iOS PWA).
const THEME_COLOR_LIGHT = '#0073e6';
const THEME_COLOR_DARK = '#030712';

const CYCLE_ORDER: DarkModePreference[] = ['light', 'dark', 'system'];

/**
 * Validates that a raw localStorage value is a valid DarkModePreference.
 * Returns 'system' for any invalid or missing value -- safe default that
 * respects user OS settings without making assumptions.
 */
function parsePreference(raw: string | null): DarkModePreference {
  if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
  return 'system';
}

/**
 * Queries the OS-level dark mode preference. This is a point-in-time check;
 * real-time tracking is handled by the matchMedia 'change' listener below.
 */
function getSystemPrefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/**
 * Resolves a preference into a concrete boolean. 'system' delegates to OS,
 * 'light' and 'dark' are explicit overrides.
 */
function resolveIsDark(pref: DarkModePreference): boolean {
  if (pref === 'dark') return true;
  if (pref === 'light') return false;
  return getSystemPrefersDark();
}

/**
 * Applies the dark/light theme to the DOM. This is the single source of truth
 * for DOM mutations -- both the hook and the index.html inline script use the
 * same logic (class toggle + theme-color meta update).
 */
function applyTheme(isDark: boolean): void {
  const root = document.documentElement;
  if (isDark) {
    root.classList.add('dark');
  } else {
    root.classList.remove('dark');
  }

  // WHY: Updating theme-color meta tag changes the browser chrome color on Android
  // and the status bar color in iOS standalone (PWA) mode, creating a polished
  // native-like appearance that matches the current theme.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.setAttribute('content', isDark ? THEME_COLOR_DARK : THEME_COLOR_LIGHT);
  }
}

// ---------------------------------------------------------------------------
// External store -- useSyncExternalStore pattern for concurrent-mode safety.
// WHY: The OS matchMedia listener and cross-tab storage events both fire outside
// React's lifecycle. useSyncExternalStore guarantees tear-free reads even under
// concurrent rendering, unlike a plain useState + useEffect approach.
// ---------------------------------------------------------------------------

interface DarkModeSnapshot {
  isDark: boolean;
  preference: DarkModePreference;
}

let _snapshot: DarkModeSnapshot = {
  preference: parsePreference(localStorage.getItem(STORAGE_KEY)),
  isDark: resolveIsDark(parsePreference(localStorage.getItem(STORAGE_KEY))),
};

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): DarkModeSnapshot {
  return _snapshot;
}

function emitChange(pref: DarkModePreference): void {
  const isDark = resolveIsDark(pref);
  // WHY: Only create a new snapshot object when the values actually change.
  // This prevents unnecessary re-renders in consuming components.
  if (_snapshot.isDark === isDark && _snapshot.preference === pref) return;
  _snapshot = { isDark, preference: pref };
  applyTheme(isDark);
  listeners.forEach((fn) => fn());
}

// WHY: Global matchMedia listener registered once at module level. When the OS theme
// changes and the user preference is 'system', we re-evaluate and apply.
// This fires for all instances of the hook simultaneously via the shared store.
const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
mediaQuery.addEventListener('change', () => {
  const currentPref = parsePreference(localStorage.getItem(STORAGE_KEY));
  if (currentPref === 'system') {
    emitChange('system');
  }
});

// WHY: Cross-tab synchronization. If the user changes dark mode preference in another
// tab, we need this tab to react immediately. The 'storage' event only fires for
// OTHER tabs/windows, not the current one -- so this is purely for multi-tab sync.
window.addEventListener('storage', (e: StorageEvent) => {
  if (e.key === STORAGE_KEY) {
    emitChange(parsePreference(e.newValue));
  }
});

// Apply theme on module initialization so the DOM is correct before any component mounts.
// This is a safety net -- the index.html inline script handles the initial flash prevention,
// but if the app is loaded via client-side navigation this ensures consistency.
applyTheme(_snapshot.isDark);

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useDarkMode(): UseDarkModeReturn {
  const { isDark, preference } = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const setPreference = useCallback((pref: DarkModePreference) => {
    localStorage.setItem(STORAGE_KEY, pref);
    emitChange(pref);
  }, []);

  const toggle = useCallback(() => {
    const currentPref = parsePreference(localStorage.getItem(STORAGE_KEY));
    const currentIndex = CYCLE_ORDER.indexOf(currentPref);
    const nextPref = CYCLE_ORDER[(currentIndex + 1) % CYCLE_ORDER.length];
    localStorage.setItem(STORAGE_KEY, nextPref);
    emitChange(nextPref);
  }, []);

  return { isDark, preference, setPreference, toggle };
}

export type { DarkModePreference, UseDarkModeReturn };
