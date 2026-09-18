/**
 * Service-worker update announcement — a tiny external store.
 *
 * WHY: `registerSW().onNeedRefresh` fires outside React, so the old code had
 * nowhere to render a dialog and fell back to the browser's blocking
 * `confirm()`. That dialog cannot be styled, ignores dark mode, blocks the
 * whole tab and is now banned by ESLint `no-alert`. The SW callback writes
 * here; `<UpdatePrompt />` subscribes with `useSyncExternalStore` and renders
 * the same in-app banner pattern as `InstallPrompt`.
 */

export interface UpdateAvailableState {
  /** A new service worker is waiting to activate. */
  readonly available: boolean;
  /** Activates the waiting worker (reloads the app). `null` while nothing is waiting. */
  readonly apply: (() => void) | null;
}

type Listener = () => void;

const IDLE: UpdateAvailableState = { available: false, apply: null };

let state: UpdateAvailableState = IDLE;
const listeners = new Set<Listener>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Called from the SW `onNeedRefresh` hook: exposes the reload action to the UI. */
export function announceUpdate(apply: () => void): void {
  state = { available: true, apply };
  notify();
}

/** Hides the banner until the next SW update is announced. */
export function dismissUpdate(): void {
  if (!state.available) return;
  state = IDLE;
  notify();
}

export function subscribeUpdate(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getUpdateSnapshot(): UpdateAvailableState {
  return state;
}
