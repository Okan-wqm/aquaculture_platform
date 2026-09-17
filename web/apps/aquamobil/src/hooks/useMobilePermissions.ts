import { get, set } from 'idb-keyval';
import {
  createElement,
  useState,
  useEffect,
  useCallback,
  useRef,
  createContext,
  useContext,
  type ReactElement,
  type ReactNode,
} from 'react';

import { useAuth } from './useAuth';

import { authenticatedFetch } from '@/services/authenticated-fetch';
import { readGraphQLResponse } from '@/utils/graphql-response';

export type MobileFeature =
  | 'mortality'
  | 'cull'
  | 'harvest'
  | 'feeding'
  | 'waterQuality'
  | 'tankView'
  | 'schedule'
  | 'attendance'
  | 'leave'
  | 'tasks'
  | 'transfer'
  | 'storage'
  | 'liceCount'
  | 'welfare'
  | 'escape'
  | 'reports';

interface MobileAllowedFeatures {
  mortality: boolean;
  cull: boolean;
  harvest: boolean;
  feeding: boolean;
  waterQuality: boolean;
  tankView: boolean;
  schedule: boolean;
  attendance: boolean;
  leave: boolean;
  tasks: boolean;
  transfer: boolean;
  storage: boolean;
  /** FARM-HIGH-214: regulatory field capture + report review (Phase 6). */
  liceCount: boolean;
  welfare: boolean;
  escape: boolean;
  reports: boolean;
}

interface MobileSettings {
  isMobileEnabled: boolean;
  allowedFeatures: MobileAllowedFeatures;
}

/**
 * Wire shape of the `getMyMobileSettings` GraphQL query result. The server
 * returns the same MobileSettings fields; typing the response end-to-end keeps
 * the `.json()` payload off the `any` path (no-unsafe-* discipline).
 */
interface MobileSettingsQueryData {
  getMyMobileSettings: MobileSettings | null;
}

/**
 * Indicates how the current permission set was resolved.
 *
 * - `'live'`        — fetched from the backend in this session
 * - `'cache'`       — loaded from IndexedDB (last-known-good, within TTL)
 * - `'stale-cache'` — loaded from IndexedDB but TTL has expired (network error path)
 * - `'fail-closed'` — no backend, no cache → all features denied
 */
export type PermissionSource = 'live' | 'cache' | 'stale-cache' | 'fail-closed';

interface MobilePermissionsContextValue {
  settings: MobileSettings;
  isLoaded: boolean;
  isMobileEnabled: boolean;
  /** SECURITY: fail-closed — true when permissions could not be fetched AND no
   *  valid cache exists. Consumers should show a degradation banner. */
  permissionsDegraded: boolean;
  /** Observability: how the current permission set was resolved. */
  permissionSource: PermissionSource;
  canAccess: (feature: MobileFeature) => boolean;
  refreshPermissions: () => Promise<void>;
}

// D07 RBAC-01: Fail-closed defaults — when the backend is unreachable and no
// cached permissions exist, deny access to all features. This prevents
// privilege escalation via network isolation attacks on shared field devices.
const DEFAULT_SETTINGS: MobileSettings = {
  isMobileEnabled: false,
  allowedFeatures: {
    mortality: false,
    cull: false,
    harvest: false,
    feeding: false,
    waterQuality: false,
    tankView: false,
    schedule: false,
    attendance: false,
    leave: false,
    tasks: false,
    transfer: false,
    storage: false,
    liceCount: false,
    welfare: false,
    escape: false,
    reports: false,
  },
};

// SECURITY: Fail-closed fallback — when backend returns an error and no valid
// cache exists, deny all features. Granting access by default on error is a
// privilege escalation vector (e.g. network isolation on shared field devices).
const FALLBACK_SETTINGS: MobileSettings = {
  isMobileEnabled: false,
  allowedFeatures: {
    mortality: false,
    cull: false,
    harvest: false,
    feeding: false,
    waterQuality: false,
    tankView: false,
    schedule: false,
    attendance: false,
    leave: false,
    tasks: false,
    transfer: false,
    storage: false,
    liceCount: false,
    welfare: false,
    escape: false,
    reports: false,
  },
};

const GET_MY_MOBILE_SETTINGS_QUERY = `
  query GetMyMobileSettings {
    getMyMobileSettings {
      isMobileEnabled
      allowedFeatures
    }
  }
`;

// SECURITY: fail-closed — cache key is tenant+user scoped so different tenants
// and users on shared devices never share permissions. Without tenantId, a user
// with the same userId in two tenants could inherit the wrong feature set.
function getCacheKey(userId: string, tenantId?: string | null): string {
  if (tenantId) {
    return `mobile_permissions_${tenantId}_${userId}`;
  }
  return `mobile_permissions_${userId}`;
}

const MobilePermissionsContext = createContext<MobilePermissionsContextValue | null>(null);

// PERF-03: Single provider at app root — fetch happens exactly once per auth session,
// shared via context to all consumers (FeatureRoute, MobileLayout, HomePage, TankCard).
export function MobilePermissionsProvider({ children }: { children: ReactNode }): ReactElement {
  const { accessToken, isAuthenticated, isLoading: authLoading, user, tenantId } = useAuth();
  const [settings, setSettings] = useState<MobileSettings>(DEFAULT_SETTINGS);
  const [isLoaded, setIsLoaded] = useState(false);
  // SECURITY: fail-closed — track whether we are in degraded mode and what
  // source resolved the current permission set.
  const [permissionSource, setPermissionSource] = useState<PermissionSource>('fail-closed');
  const [permissionsDegraded, setPermissionsDegraded] = useState(false);

  // BUG-16: Use ref to hold latest fetchSettings so the effect only re-runs when
  // isAuthenticated transitions, not on every token refresh. The initial value is
  // a no-op resolved promise (replaced by the real fetchSettings on first effect
  // run) — written as `() => Promise.resolve()` so it is neither an empty function
  // body nor an async function with no await.
  const fetchSettingsRef = useRef<() => Promise<void>>(() => Promise.resolve());

  const fetchSettings = useCallback(async () => {
    if (!accessToken || !user?.id) return;

    const cacheKey = getCacheKey(user.id, tenantId);

    try {
      const response = await authenticatedFetch('/graphql', {
        method: 'POST',
        body: JSON.stringify({ query: GET_MY_MOBILE_SETTINGS_QUERY }),
      });

      // SEC-04: On auth error, clear stale permissions
      // Note: authenticatedFetch already retries once on 401, so if we still get 401
      // here the refresh truly failed.
      if (response.status === 401) {
        // SECURITY: fail-closed — 401 means the session is invalid.
        setSettings({ ...DEFAULT_SETTINGS, isMobileEnabled: false });
        setPermissionSource('fail-closed');
        setPermissionsDegraded(true);
        setIsLoaded(true);
        return;
      }

      const result = await readGraphQLResponse<MobileSettingsQueryData>(response);
      const fetched = result.data?.getMyMobileSettings;

      if (fetched) {
        const newSettings: MobileSettings = {
          isMobileEnabled: fetched.isMobileEnabled,
          allowedFeatures: fetched.allowedFeatures,
        };
        setSettings(newSettings);
        setPermissionSource('live');
        setPermissionsDegraded(false);
        // SEC-04: Cache under tenant+user key with 8-hour TTL (one work shift)
        try {
          await set(cacheKey, {
            settings: newSettings,
            expiresAt: Date.now() + 8 * 60 * 60 * 1000,
          });
        } catch {
          // Cache write failed — settings are still applied in memory via setSettings above.
        }
      } else if (result.errors) {
        // SECURITY: fail-closed — backend returned a GraphQL error.
        // Try valid (non-expired) cache first, otherwise deny all features.
        const cached = await get<{ settings: MobileSettings; expiresAt: number }>(cacheKey);
        if (cached && cached.expiresAt > Date.now()) {
          setSettings(cached.settings);
          setPermissionSource('cache');
          setPermissionsDegraded(false);
        } else {
          // SECURITY: fail-closed — no valid cache, deny all features.
          setSettings(FALLBACK_SETTINGS);
          setPermissionSource('fail-closed');
          setPermissionsDegraded(true);
        }
      }
    } catch {
      // SECURITY: fail-closed — network error. Try cache (accept stale for
      // transient outages), otherwise deny all features.
      try {
        const cached = await get<{ settings: MobileSettings; expiresAt: number }>(cacheKey);
        if (cached) {
          // WHY: On network error we accept stale cache because the failure is
          // likely transient. On GraphQL error we reject expired cache because
          // the server may have revoked permissions intentionally.
          const isStale = cached.expiresAt <= Date.now();
          setSettings(cached.settings);
          setPermissionSource(isStale ? 'stale-cache' : 'cache');
          setPermissionsDegraded(isStale);
        } else {
          // SECURITY: fail-closed — no cache available, deny all features.
          setSettings(FALLBACK_SETTINGS);
          setPermissionSource('fail-closed');
          setPermissionsDegraded(true);
        }
      } catch {
        // SECURITY: fail-closed — IndexedDB read also failed, deny all features.
        setSettings(FALLBACK_SETTINGS);
        setPermissionSource('fail-closed');
        setPermissionsDegraded(true);
      }
    } finally {
      setIsLoaded(true);
    }
  }, [accessToken, user?.id, tenantId]);

  // Keep ref in sync with latest callback
  useEffect(() => {
    fetchSettingsRef.current = fetchSettings;
  }, [fetchSettings]);

  // BUG-05: Check authLoading before marking loaded with defaults.
  // Only run effect when isAuthenticated transitions (not on every token refresh).
  useEffect(() => {
    // Wait for auth to finish loading before evaluating state
    if (authLoading) return;

    if (!isAuthenticated || !user?.id) {
      // Not logged in — reset to defaults without fetching
      setSettings(DEFAULT_SETTINGS);
      setIsLoaded(true);
      return;
    }

    // WHY: If accessType is PANEL_ONLY, this user should never have mobile access.
    // Short-circuit to fail-closed defaults without making a network request.
    if ((user as { accessType?: string }).accessType === 'PANEL_ONLY') {
      setSettings({ ...DEFAULT_SETTINGS, isMobileEnabled: false });
      setIsLoaded(true);
      return;
    }

    const cacheKey = getCacheKey(user.id, tenantId);

    // WHY void on the IIFE: the cache-then-fetch sequence is fire-and-forget
    // within the effect; the Promise is explicitly discarded so it is not a
    // floating promise.
    void (async () => {
      // BUG-07: Load cached first for instant UI (tenant+user key).
      // Accept stale cache too — show something immediately while fresh data loads.
      try {
        const cached = await get<{ settings: MobileSettings; expiresAt: number }>(cacheKey);
        if (cached) {
          const isStale = cached.expiresAt <= Date.now();
          setSettings(cached.settings);
          setPermissionSource(isStale ? 'stale-cache' : 'cache');
          setPermissionsDegraded(isStale);
          setIsLoaded(true);
        }
      } catch {
        // IndexedDB read failed — continue to fetch from server
      }
      // Then fetch fresh from server (via the ref so the effect re-runs only on
      // the auth-identity transitions below, never on every token refresh — BUG-16).
      await fetchSettingsRef.current();
    })();
    // BUG-16: depend only on the auth-identity transitions. fetchSettings is read
    // through fetchSettingsRef (kept current by the effect above), so it is
    // deliberately not a dependency — and react-hooks/exhaustive-deps does not
    // run on this .ts file, so no suppression directive is needed.
  }, [isAuthenticated, authLoading, user?.id, tenantId]);

  const canAccess = useCallback(
    (feature: MobileFeature): boolean => {
      if (!settings.isMobileEnabled) return false;
      return settings.allowedFeatures[feature] ?? false;
    },
    [settings],
  );

  // Use createElement instead of JSX so this file can remain .ts (no .tsx extension needed).
  return createElement(
    MobilePermissionsContext.Provider,
    {
      value: {
        settings,
        isLoaded,
        isMobileEnabled: settings.isMobileEnabled,
        permissionsDegraded,
        permissionSource,
        canAccess,
        refreshPermissions: fetchSettings,
      },
    },
    children,
  );
}

// PERF-03: Hook reads from context — no independent fetch per consumer.
export function useMobilePermissions(): MobilePermissionsContextValue {
  const context = useContext(MobilePermissionsContext);
  if (!context) {
    throw new Error('useMobilePermissions must be used within MobilePermissionsProvider');
  }
  return context;
}
