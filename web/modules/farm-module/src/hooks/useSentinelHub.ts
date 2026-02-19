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

// Request a short-lived Sentinel Hub access token from the backend.
// The backend exchanges clientId/clientSecret server-side and returns only the token.
const SENTINEL_HUB_TOKEN_QUERY = `
  query SentinelHubToken {
    sentinelHubToken {
      accessToken
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

  // State
  const [sentinelToken, setSentinelToken] = useState<string | null>(null);
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
   * Fetch a short-lived Sentinel Hub access token from the backend.
   * The backend performs the OAuth client_credentials exchange server-side.
   */
  const fetchToken = useCallback(async () => {
    if (!authToken) return;
    try {
      const data = await graphqlClient.request<{
        sentinelHubToken: { accessToken: string; expiresIn: number };
      }>(SENTINEL_HUB_TOKEN_QUERY);

      if (data.sentinelHubToken?.accessToken) {
        setSentinelToken(data.sentinelHubToken.accessToken);
        setIsInitialized(true);
        setError(null);
      } else {
        setIsConfigured(false);
        setIsInitialized(false);
      }
    } catch (err) {
      if (import.meta.env.DEV) console.error('Failed to fetch Sentinel Hub token:', err);
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
      fetchToken();
    }
  }, [authToken, fetchStatus, fetchToken]);

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
   * Fetch satellite image using the server-supplied access token
   */
  const fetchImage = useCallback(
    async (
      bbox: [number, number, number, number],
      date: Date,
      layer: LayerType = 'TRUE-COLOR'
    ) => {
      if (!isInitialized || !sentinelToken) {
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
          sentinelToken,
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
    [isInitialized, sentinelToken]
  );

  /**
   * Fetch available dates for a location
   */
  const fetchAvailableDates = useCallback(
    async (bbox: [number, number, number, number], from: Date, to: Date) => {
      if (!isInitialized || !sentinelToken) return;

      try {
        const dates = await getAvailableDates(bbox, from, to, sentinelToken);
        setAvailableDates(dates);
      } catch (err) {
        if (import.meta.env.DEV) console.error('Failed to fetch available dates:', err);
        setAvailableDates([]);
      }
    },
    [isInitialized, sentinelToken]
  );

  /**
   * Refresh token and status from backend
   */
  const refreshCredentials = useCallback(async () => {
    setIsInitialized(false);
    setSentinelToken(null);
    await fetchStatus();
    await fetchToken();
  }, [fetchStatus, fetchToken]);

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
