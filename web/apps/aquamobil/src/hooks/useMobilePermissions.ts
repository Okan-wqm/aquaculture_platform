import { createElement, useState, useEffect, useCallback, useRef, createContext, useContext, ReactNode } from 'react';
import { get, set } from 'idb-keyval';
import { useAuth } from './useAuth';
import { authenticatedFetch } from '@/services/authenticated-fetch';

export type MobileFeature = 'mortality' | 'cull' | 'harvest' | 'feeding' | 'waterQuality' | 'tankView' | 'schedule' | 'attendance' | 'leave' | 'tasks' | 'transfer' | 'storage';

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
}

interface MobileSettings {
  isMobileEnabled: boolean;
  allowedFeatures: MobileAllowedFeatures;
}

interface MobilePermissionsContextValue {
  settings: MobileSettings;
  isLoaded: boolean;
  isMobileEnabled: boolean;
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

// SEC-04: Cache key is per-user so different users on shared devices don't share permissions.
function getCacheKey(userId: string): string {
  return `mobile_permissions_${userId}`;
}

const MobilePermissionsContext = createContext<MobilePermissionsContextValue | null>(null);

// PERF-03: Single provider at app root — fetch happens exactly once per auth session,
// shared via context to all consumers (FeatureRoute, MobileLayout, HomePage, TankCard).
export function MobilePermissionsProvider({ children }: { children: ReactNode }) {
  const { accessToken, isAuthenticated, isLoading: authLoading, user } = useAuth();
  const [settings, setSettings] = useState<MobileSettings>(DEFAULT_SETTINGS);
  const [isLoaded, setIsLoaded] = useState(false);

  // BUG-16: Use ref to hold latest fetchSettings so the effect only re-runs when
  // isAuthenticated transitions, not on every token refresh.
  const fetchSettingsRef = useRef<() => Promise<void>>(async () => {});

  const fetchSettings = useCallback(async () => {
    if (!accessToken || !user?.id) return;

    const cacheKey = getCacheKey(user.id);

    try {
      const response = await authenticatedFetch('/graphql', {
        method: 'POST',
        body: JSON.stringify({ query: GET_MY_MOBILE_SETTINGS_QUERY }),
      });

      // SEC-04: On auth error, clear stale permissions
      // Note: authenticatedFetch already retries once on 401, so if we still get 401
      // here the refresh truly failed.
      if (response.status === 401) {
        setSettings({ ...DEFAULT_SETTINGS, isMobileEnabled: false });
        setIsLoaded(true);
        return;
      }

      const result = await response.json();

      if (result.data?.getMyMobileSettings) {
        const fetched = result.data.getMyMobileSettings;
        const newSettings: MobileSettings = {
          isMobileEnabled: fetched.isMobileEnabled,
          allowedFeatures: fetched.allowedFeatures,
        };
        setSettings(newSettings);
        // SEC-04: Cache under per-user key with 8-hour TTL (one work shift)
        try {
          await set(cacheKey, { settings: newSettings, expiresAt: Date.now() + 8 * 60 * 60 * 1000 });
        } catch {
          // Cache write failed — settings are still applied in memory via setSettings above.
        }
      } else if (result.errors) {
        // Backend returned a GraphQL error — try cache first, otherwise apply
        // fail-closed fallback.
        const cached = await get<{ settings: MobileSettings; expiresAt: number }>(cacheKey);
        if (cached && cached.expiresAt > Date.now()) {
          setSettings(cached.settings);
        } else {
          setSettings(FALLBACK_SETTINGS);
        }
      }
    } catch {
      // On network error, try to load from per-user cache, then fallback
      try {
        const cached = await get<{ settings: MobileSettings; expiresAt: number }>(cacheKey);
        if (cached) {
          setSettings(cached.settings);
        } else {
          // No cache available — use fail-closed fallback
          setSettings(FALLBACK_SETTINGS);
        }
      } catch {
        // IndexedDB read also failed — use fallback
        setSettings(FALLBACK_SETTINGS);
      }
    } finally {
      setIsLoaded(true);
    }
  }, [accessToken, user?.id]);

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

    const cacheKey = getCacheKey(user.id);

    (async () => {
      // BUG-07: Load cached first for instant UI (per-user key).
      // Accept stale cache too — show something immediately while fresh data loads.
      try {
        const cached = await get<{ settings: MobileSettings; expiresAt: number }>(cacheKey);
        if (cached) {
          setSettings(cached.settings);
          setIsLoaded(true);
        }
      } catch {
        // IndexedDB read failed — continue to fetch from server
      }
      // Then fetch fresh from server
      await fetchSettingsRef.current();
    })();
  // Intentionally only depends on isAuthenticated/authLoading/user?.id to avoid
  // re-fetching on every token refresh (BUG-16).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, authLoading, user?.id]);

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
