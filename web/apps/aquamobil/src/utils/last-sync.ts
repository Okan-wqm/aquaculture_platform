/**
 * MOB-LOW-011 — the global "last successfully synced" clock.
 *
 * Written at the drain convergence points (useOfflineQueue.syncNow after a
 * successful drain, plus the Account page's manual sync), read by the sync
 * surfaces through the DataFreshness stamp. localStorage is the right store:
 * it is one non-sensitive timestamp, already part of the logout wipe
 * (useAuth removes this exact key).
 */

export const LAST_SYNC_STORAGE_KEY = 'aquamobil_last_sync_at';

/** Record "now" as the last successful sync. Safe in private-mode browsers. */
export function recordLastSyncAt(): void {
  try {
    localStorage.setItem(LAST_SYNC_STORAGE_KEY, new Date().toISOString());
  } catch {
    // Storage unavailable (private mode / quota) — the clock simply stays empty.
  }
}

/** The last successful sync stamp, or null when never synced on this device. */
export function getLastSyncAt(): string | null {
  try {
    return localStorage.getItem(LAST_SYNC_STORAGE_KEY);
  } catch {
    return null;
  }
}
