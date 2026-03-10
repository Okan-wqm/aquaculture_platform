import { createElement, useState, useEffect, useCallback, useRef, createContext, useContext, ReactNode } from 'react';
import { get, set } from 'idb-keyval';
import { useAuth } from './useAuth';

export type MobileFeature = 'mortality' | 'cull' | 'harvest' | 'feeding' | 'waterQuality' | 'tankView' | 'schedule' | 'attendance' | 'leave' | 'tasks' | 'transfer';

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

const DEFAULT_SETTINGS: MobileSettings = {
  isMobileEnabled: true,
  allowedFeatures: {
    mortality: true,
    cull: true,
    harvest: true,
    feeding: true,
    waterQuality: false,
    tankView: true,
    schedule: true,
    attendance: true,
    leave: true,
    tasks: true,
    transfer: true,
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
      const response = await fetch('/graphql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({ query: GET_MY_MOBILE_SETTINGS_QUERY }),
      });

      // SEC-04: On auth error, clear stale permissions
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
        await set(cacheKey, { settings: newSettings, expiresAt: Date.now() + 8 * 60 * 60 * 1000 });
      }
    } catch {
      // On network error, try to load from per-user cache
      const cached = await get<{ settings: MobileSettings; expiresAt: number }>(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        setSettings(cached.settings);
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

    const cacheKey = getCacheKey(user.id);

    (async () => {
      // Load cached first for instant UI (per-user key)
      const cached = await get<{ settings: MobileSettings; expiresAt: number }>(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        setSettings(cached.settings);
        setIsLoaded(true);
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
