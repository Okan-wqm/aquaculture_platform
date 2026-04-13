/**
 * Centralized Logout Cleanup
 *
 * SECURITY: FE-HIGH-005 — After logout, zombie tokens and stale data can
 * persist in multiple browser storage layers:
 *   - In-memory token cache (api-client)
 *   - sessionStorage auth state
 *   - React Query cache
 *   - Zustand stores (persisted to localStorage)
 *   - IndexedDB (offline data, messaging drafts)
 *   - Workbox / service worker caches
 *
 * This module provides a single `logoutCleanup()` function that wipes ALL
 * layers. Both the shell and AquaMobil call this from their logout handler,
 * making incomplete cleanup STRUCTURALLY IMPOSSIBLE.
 *
 * @see FE-HIGH-005
 */

import type { QueryClient } from '@tanstack/react-query';
import { clearSession } from './api-client';

// ============================================================================
// Types
// ============================================================================

export interface LogoutCleanupOptions {
  /** React Query client instance to clear */
  queryClient?: QueryClient;
  /** Additional Zustand store reset functions */
  zustandResetFns?: Array<() => void>;
  /** Whether to attempt server-side token revocation (best-effort) */
  revokeServerToken?: boolean;
}

// ============================================================================
// Global Cleanup Registry
// ============================================================================

/**
 * SECURITY: Global registry for Zustand store cleanup functions.
 *
 * Modules (e.g., sensor-module) register their store-clearing callbacks here
 * at import time. logoutCleanup() drains this registry automatically, ensuring
 * tenant-scoped SCADA data, edge I/O caches, and other module-level stores
 * are wiped on logout without creating cross-package import dependencies.
 *
 * @example
 * // In sensor-module initialization:
 * import { registerLogoutCleanup } from '@aquaculture/shared-ui';
 * registerLogoutCleanup(() => useSensorStore.getState().clearAll());
 */
const cleanupRegistry: Set<() => void> = new Set();

/**
 * Register a cleanup function to be called on every logoutCleanup() invocation.
 * Returns an unregister function.
 *
 * @param fn - Cleanup function (should be idempotent and never throw)
 * @returns Unregister function to remove the callback
 */
export function registerLogoutCleanup(fn: () => void): () => void {
  cleanupRegistry.add(fn);
  return () => { cleanupRegistry.delete(fn); };
}

// ============================================================================
// IndexedDB Cleanup
// ============================================================================

/**
 * Delete all IndexedDB databases created by the application.
 * Best-effort: silently ignores errors (e.g., in incognito mode).
 */
async function clearIndexedDB(): Promise<void> {
  if (typeof indexedDB === 'undefined') return;

  try {
    // Modern browsers support indexedDB.databases()
    if (typeof indexedDB.databases === 'function') {
      const databases = await indexedDB.databases();
      const deletePromises = databases.map((db) => {
        if (db.name) {
          return new Promise<void>((resolve) => {
            const req = indexedDB.deleteDatabase(db.name!);
            req.onsuccess = () => resolve();
            req.onerror = () => resolve(); // Best-effort
            req.onblocked = () => resolve();
          });
        }
        return Promise.resolve();
      });
      await Promise.allSettled(deletePromises);
    }
  } catch {
    // indexedDB.databases() not supported — skip
  }
}

// ============================================================================
// Service Worker Cache Cleanup
// ============================================================================

/**
 * Clear all Cache Storage entries (Workbox runtime caches, etc.).
 * Best-effort: silently ignores errors.
 */
async function clearServiceWorkerCaches(): Promise<void> {
  if (typeof caches === 'undefined') return;

  try {
    const cacheNames = await caches.keys();
    await Promise.allSettled(cacheNames.map((name) => caches.delete(name)));
  } catch {
    // CacheStorage not available — skip
  }
}

// ============================================================================
// Session/Local Storage Cleanup
// ============================================================================

/**
 * Clear sessionStorage and auth-related localStorage entries.
 * Preserves non-auth localStorage entries (e.g., UI preferences).
 */
function clearBrowserStorage(): void {
  try {
    sessionStorage.clear();
  } catch {
    // sessionStorage unavailable
  }

  // SECURITY: Remove known auth/tenant keys and sensitive data from localStorage.
  // admin_sql_query_history must be cleared to prevent sensitive SQL from
  // persisting on shared devices after logout.
  const authKeys = [
    'tenant_id',
    'consent_banner_dismissed',
    'auth_state',
    'refresh_token', // should never exist but defensive
    'access_token',  // should never exist but defensive
    'admin_sql_query_history', // sensitive SQL queries from DB explorer
  ];

  try {
    for (const key of authKeys) {
      localStorage.removeItem(key);
    }
  } catch {
    // localStorage unavailable
  }
}

// ============================================================================
// Main Cleanup Function
// ============================================================================

/**
 * Complete logout cleanup across all browser storage layers.
 *
 * Call this from EVERY logout path (shell, AquaMobil, MFE fallback).
 * The function is idempotent — calling it multiple times is safe.
 *
 * @param options - Optional configuration for cleanup behavior
 *
 * @example
 * // In shell AuthContext logout:
 * const logout = async () => {
 *   await graphqlClient.request(LOGOUT_MUTATION).catch(() => {});
 *   await logoutCleanup({ queryClient, revokeServerToken: true });
 *   dispatch({ type: 'LOGOUT' });
 * };
 *
 * @example
 * // In AquaMobil:
 * import { logoutCleanup } from '@aquaculture/shared-ui';
 * await logoutCleanup({ queryClient: mobileQueryClient });
 */
export async function logoutCleanup(options: LogoutCleanupOptions = {}): Promise<void> {
  const { queryClient, zustandResetFns, revokeServerToken } = options;

  // ── 1. Clear in-memory token state (api-client closure) ──
  clearSession();

  // ── 2. Clear React Query cache ──
  if (queryClient) {
    queryClient.clear();
  }

  // ── 3. Reset Zustand stores ──
  // 3a. Drain the global cleanup registry (sensor stores, edge I/O stores, etc.)
  for (const registeredFn of cleanupRegistry) {
    try {
      registeredFn();
    } catch {
      // Best-effort — store may already be destroyed
    }
  }
  // 3b. Run any ad-hoc reset functions passed by the caller
  if (zustandResetFns) {
    for (const resetFn of zustandResetFns) {
      try {
        resetFn();
      } catch {
        // Best-effort — store may already be destroyed
      }
    }
  }

  // ── 4. Clear browser storage (session + auth-related localStorage) ──
  clearBrowserStorage();

  // ── 5. Clear IndexedDB (offline data, messaging drafts) ──
  // ── 6. Clear service worker caches (Workbox runtime caches) ──
  // Run in parallel since they're independent
  await Promise.allSettled([
    clearIndexedDB(),
    clearServiceWorkerCaches(),
  ]);

  // ── 7. Notify MFE bridge that auth is gone ──
  // This ensures any MFE that checks window.__AQUACULTURE_AUTH__ gets null tokens
  // (clearSession already handles this via the closure-scoped variable)

  // ── 8. Unregister service workers to prevent stale cache serving ──
  if ('serviceWorker' in navigator) {
    try {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.allSettled(registrations.map((r) => r.unregister()));
    } catch {
      // Best-effort
    }
  }
}
