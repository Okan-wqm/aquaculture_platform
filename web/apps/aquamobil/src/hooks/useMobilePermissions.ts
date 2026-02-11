import { useState, useEffect, useCallback } from 'react';
import { get, set } from 'idb-keyval';
import { useAuth } from './useAuth';

export type MobileFeature = 'mortality' | 'cull' | 'harvest' | 'feeding' | 'waterQuality' | 'tankView' | 'schedule';

interface MobileAllowedFeatures {
  mortality: boolean;
  cull: boolean;
  harvest: boolean;
  feeding: boolean;
  waterQuality: boolean;
  tankView: boolean;
  schedule: boolean;
}

interface MobileSettings {
  isMobileEnabled: boolean;
  allowedFeatures: MobileAllowedFeatures;
}

const CACHE_KEY = 'mobile_permissions';

const DEFAULT_SETTINGS: MobileSettings = {
  isMobileEnabled: true,
  allowedFeatures: {
    mortality: true,
    cull: true,
    harvest: true,
    feeding: false,
    waterQuality: false,
    tankView: true,
    schedule: true,
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

export function useMobilePermissions() {
  const { accessToken, isAuthenticated } = useAuth();
  const [settings, setSettings] = useState<MobileSettings>(DEFAULT_SETTINGS);
  const [isLoaded, setIsLoaded] = useState(false);

  const fetchSettings = useCallback(async () => {
    if (!accessToken) return;

    try {
      const response = await fetch('/graphql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ query: GET_MY_MOBILE_SETTINGS_QUERY }),
      });

      const result = await response.json();

      if (result.data?.getMyMobileSettings) {
        const fetched = result.data.getMyMobileSettings;
        const newSettings: MobileSettings = {
          isMobileEnabled: fetched.isMobileEnabled,
          allowedFeatures: fetched.allowedFeatures,
        };
        setSettings(newSettings);
        // Cache to IndexedDB for offline use
        await set(CACHE_KEY, newSettings);
      }
    } catch {
      // On network error, try to load from cache
      const cached = await get<MobileSettings>(CACHE_KEY);
      if (cached) {
        setSettings(cached);
      }
    } finally {
      setIsLoaded(true);
    }
  }, [accessToken]);

  // Load from cache first, then fetch fresh
  useEffect(() => {
    if (!isAuthenticated) {
      setIsLoaded(true);
      return;
    }

    (async () => {
      // Load cached first for instant UI
      const cached = await get<MobileSettings>(CACHE_KEY);
      if (cached) {
        setSettings(cached);
        setIsLoaded(true);
      }
      // Then fetch fresh
      await fetchSettings();
    })();
  }, [isAuthenticated, fetchSettings]);

  const canAccess = useCallback(
    (feature: MobileFeature): boolean => {
      if (!settings.isMobileEnabled) return false;
      return settings.allowedFeatures[feature] ?? false;
    },
    [settings],
  );

  return {
    settings,
    isLoaded,
    isMobileEnabled: settings.isMobileEnabled,
    canAccess,
    refreshPermissions: fetchSettings,
  };
}
