import { useCallback, useSyncExternalStore } from 'react';

/**
 * useDensity -- touch-target density for gloved operation.
 *
 * AquaMobil is used outdoors on a pen edge, frequently with wet gloves. The v4
 * design answers that with a single switch in Account ("Touch targets:
 * Standard / Gloves") that enlarges EVERY control in the app at once.
 *
 * WHY an attribute + CSS variables rather than a React context threaded into
 * each control: the density has to reach controls inside Konsta components,
 * inside portals, and inside the service-worker-rendered install prompt —
 * places a context does not reach. `<html data-density="glove">` reaches all of
 * them, and the sizes live next to the colour tokens in src/styles/tokens.css.
 *
 * This is NOT the accessibility floor. The 44px floor is the `touch` spacing
 * token in tailwind.config.js, enforced by field-ergonomics.invariant.spec.ts;
 * glove mode raises targets above that floor and can never lower them.
 */

type Density = 'standard' | 'glove';

interface UseDensityReturn {
  density: Density;
  setDensity: (next: Density) => void;
  /** Convenience for controls that change layout, not just size, under gloves. */
  isGlove: boolean;
}

const STORAGE_KEY = 'aquamobil_touch_density';

function parseDensity(raw: string | null): Density {
  return raw === 'glove' ? 'glove' : 'standard';
}

/** The ONLY place density touches the DOM. Mirrored by index.html's inline script. */
function applyDensity(density: Density): void {
  document.documentElement.setAttribute('data-density', density);
}

let _snapshot: Density = parseDensity(localStorage.getItem(STORAGE_KEY));

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): Density {
  return _snapshot;
}

function emitChange(next: Density): void {
  if (_snapshot === next) return;
  _snapshot = next;
  applyDensity(next);
  listeners.forEach((fn) => fn());
}

// Cross-tab sync — a worker changing density on one open tab should not find
// the other tab still at the old size.
window.addEventListener('storage', (e: StorageEvent) => {
  if (e.key === STORAGE_KEY) {
    emitChange(parseDensity(e.newValue));
  }
});

applyDensity(_snapshot);

export function useDensity(): UseDensityReturn {
  const density = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const setDensity = useCallback((next: Density) => {
    localStorage.setItem(STORAGE_KEY, next);
    emitChange(next);
  }, []);

  return { density, setDensity, isGlove: density === 'glove' };
}

export type { Density, UseDensityReturn };
