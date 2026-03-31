/**
 * useSentinelHub Hook
 *
 * Sentinel Hub API ile etkileşim için React hook.
 * Fetches a short-lived access token from the backend (never the raw clientSecret)
 * and uses it to initialise/fetch satellite imagery.
 *
 * Security: uses `useAuth()` from shared-ui instead of localStorage.getItem().
 * HIGH-05 fix: the clientSecret is never requested from the backend.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { useAuth, graphqlClient } from '@aquaculture/shared-ui';
import {
  getSatelliteImage,
  getAvailableDates,
  clearCache,
  type LayerType,
} from '../services/sentinelHubService';

// Only request the Sentinel Hub status (masked clientId, isConfigured flag).
// The raw clientSecret must NEVER be fetched to the browser.
const SENTINEL_HUB_STATUS_QUERY = `
  query SentinelHubStatus {
    sentinelHubStatus {
      isConfigured
      clientIdMasked
      lastUsed
      usageCount
    }
  }
`;

/**
 * SEC-C14: Token check query returns only expiresIn (accessToken is @HideField).
 * Used solely to verify that backend credentials are configured and working.
 * All actual Sentinel Hub API calls go through the backend proxy (/api/sentinel-hub/*).
 */
const SENTINEL_HUB_TOKEN_CHECK_QUERY = `
  query SentinelHubToken {
    sentinelHubToken {
      expiresIn
    }
  }
`;

export interface SentinelHubStatus {
  isConfigured: boolean;
  clientIdMasked: string | null;
  lastUsed: string | null;
  usageCount: number;
}

export interface UseSentinelHubReturn {
  // State
  isInitialized: boolean;
  isLoading: boolean;
  isConfigured: boolean;
  error: string | null;
  imageUrl: string | null;
  availableDates: Date[];
  status: SentinelHubStatus | null;

  // Actions
  fetchImage: (
    bbox: [number, number, number, number],
    date: Date,
    layer?: LayerType
  ) => Promise<void>;
  fetchAvailableDates: (
    bbox: [number, number, number, number],
    from: Date,
    to: Date
  ) => Promise<void>;
  refreshCredentials: () => Promise<void>;
  clearImageCache: () => void;
}

export function useSentinelHub(): UseSentinelHubReturn {
  const { token: authToken } = useAuth();

  // SEC-C14: sentinelToken is no longer stored in the browser.
  // It exists only on the backend. We track only "verified" state.
  const [isInitialized, setIsInitialized] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isConfigured, setIsConfigured] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [availableDates, setAvailableDates] = useState<Date[]>([]);
  const [status, setStatus] = useState<SentinelHubStatus | null>(null);

  const previousImageUrl = useRef<string | null>(null);

  /**
   * Fetch Sentinel Hub status (isConfigured, masked clientId) from backend.
   * Does NOT fetch credentials/clientSecret.
   */
  const fetchStatus = useCallback(async () => {
    if (!authToken) return;
    try {
      const data = await graphqlClient.request<{
        sentinelHubStatus: SentinelHubStatus;
      }>(SENTINEL_HUB_STATUS_QUERY);

      if (data.sentinelHubStatus) {
        setStatus(data.sentinelHubStatus);
        setIsConfigured(data.sentinelHubStatus.isConfigured);
      }
    } catch (err) {
      if (import.meta.env.DEV) console.error('Failed to fetch Sentinel Hub status:', err);
      setIsConfigured(false);
    }
  }, [authToken]);

  /**
   * SEC-C14: Verify that backend credentials are working.
   * The token never reaches the browser — only expiresIn is returned.
   * All API calls go through the backend proxy (/api/sentinel-hub/*).
   */
  const verifyCredentials = useCallback(async () => {
    if (!authToken) return;
    try {
      const data = await graphqlClient.request<{
        sentinelHubToken: { expiresIn: number } | null;
      }>(SENTINEL_HUB_TOKEN_CHECK_QUERY);

      if (data.sentinelHubToken?.expiresIn) {
        setIsInitialized(true);
        setError(null);
      } else {
        setIsConfigured(false);
        setIsInitialized(false);
      }
    } catch (err) {
      if (import.meta.env.DEV) console.error('Failed to verify Sentinel Hub credentials:', err);
      setIsConfigured(false);
      setIsInitialized(false);
    }
  }, [authToken]);

  /**
   * Initialize on mount / when auth token is available
   */
  useEffect(() => {
    if (authToken) {
      fetchStatus();
      verifyCredentials();
    }
  }, [authToken, fetchStatus, verifyCredentials]);

  /**
   * Clean up blob URLs on unmount
   */
  useEffect(() => {
    return () => {
      if (previousImageUrl.current) {
        URL.revokeObjectURL(previousImageUrl.current);
      }
    };
  }, []);

  /**
   * Fetch satellite image via backend proxy.
   * SEC-C14: No token is passed — the backend handles authentication.
   */
  const fetchImage = useCallback(
    async (
      bbox: [number, number, number, number],
      date: Date,
      layer: LayerType = 'TRUE-COLOR'
    ) => {
      if (!isInitialized) {
        setError('Sentinel Hub yapılandırılmamış. Ayarlar sayfasından yapılandırın.');
        return;
      }

      setIsLoading(true);
      setError(null);

      try {
        const endDate = new Date(date);
        endDate.setDate(endDate.getDate() + 1);

        const blob = await getSatelliteImage(
          {
            bbox,
            fromDate: date,
            toDate: endDate,
            layer,
            width: 512,
            height: 512,
          },
        );

        if (previousImageUrl.current) {
          URL.revokeObjectURL(previousImageUrl.current);
        }

        const url = URL.createObjectURL(blob);
        previousImageUrl.current = url;
        setImageUrl(url);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Görüntü alınamadı';
        setError(message);
      } finally {
        setIsLoading(false);
      }
    },
    [isInitialized]
  );

  /**
   * Fetch available dates for a location via backend proxy
   */
  const fetchAvailableDates = useCallback(
    async (bbox: [number, number, number, number], from: Date, to: Date) => {
      if (!isInitialized) return;

      try {
        const dates = await getAvailableDates(bbox, from, to);
        setAvailableDates(dates);
      } catch (err) {
        if (import.meta.env.DEV) console.error('Failed to fetch available dates:', err);
        setAvailableDates([]);
      }
    },
    [isInitialized]
  );

  /**
   * Refresh credential status from backend
   */
  const refreshCredentials = useCallback(async () => {
    setIsInitialized(false);
    await fetchStatus();
    await verifyCredentials();
  }, [fetchStatus, verifyCredentials]);

  /**
   * Clear image cache
   */
  const clearImageCache = useCallback(() => {
    clearCache();
    if (previousImageUrl.current) {
      URL.revokeObjectURL(previousImageUrl.current);
      previousImageUrl.current = null;
    }
    setImageUrl(null);
  }, []);

  return {
    isInitialized,
    isLoading,
    isConfigured,
    error,
    imageUrl,
    availableDates,
    status,
    fetchImage,
    fetchAvailableDates,
    refreshCredentials,
    clearImageCache,
  };
}

export default useSentinelHub;
