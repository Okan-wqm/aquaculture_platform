/**
 * useSentinelHub Hook
 *
 * Sentinel Hub API ile etkileşim için React hook.
 * Credentials'ları backend'den alır ve görüntü/tarih çekme işlemlerini yönetir.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import {
  initSentinelHub,
  getSatelliteImage,
  getAvailableDates,
  clearCache,
  type SentinelConfig,
  type LayerType,
} from '../services/sentinelHubService';

// GraphQL queries
const SENTINEL_HUB_CREDENTIALS_QUERY = `
  query SentinelHubCredentials {
    sentinelHubCredentials {
      clientId
      clientSecret
    }
  }
`;

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
  // State
  const [credentials, setCredentials] = useState<SentinelConfig | null>(null);
  const [isInitialized, setIsInitialized] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isConfigured, setIsConfigured] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [availableDates, setAvailableDates] = useState<Date[]>([]);
  const [status, setStatus] = useState<SentinelHubStatus | null>(null);

  // Refs
  const previousImageUrl = useRef<string | null>(null);

  /**
   * Fetch credentials from backend
   */
  const fetchCredentials = useCallback(async () => {
    try {
      const token = localStorage.getItem('access_token');
      if (!token) {
        setIsConfigured(false);
        return;
      }

      const response = await fetch('/graphql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ query: SENTINEL_HUB_CREDENTIALS_QUERY }),
      });

      const result = await response.json();

      if (result.data?.sentinelHubCredentials) {
        setCredentials(result.data.sentinelHubCredentials);
        setIsConfigured(true);
      } else {
        setIsConfigured(false);
        setCredentials(null);
      }
    } catch (err) {
      console.error('Failed to fetch Sentinel Hub credentials:', err);
      setIsConfigured(false);
    }
  }, []);

  /**
   * Fetch status from backend
   */
  const fetchStatus = useCallback(async () => {
    try {
      const token = localStorage.getItem('access_token');
      if (!token) return;

      const response = await fetch('/graphql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ query: SENTINEL_HUB_STATUS_QUERY }),
      });

      const result = await response.json();

      if (result.data?.sentinelHubStatus) {
        setStatus(result.data.sentinelHubStatus);
        setIsConfigured(result.data.sentinelHubStatus.isConfigured);
      }
    } catch (err) {
      console.error('Failed to fetch Sentinel Hub status:', err);
    }
  }, []);

  /**
   * Initialize Sentinel Hub when credentials are available
   */
  useEffect(() => {
    if (credentials) {
      setIsLoading(true);
      initSentinelHub(credentials)
        .then(() => {
          setIsInitialized(true);
          setError(null);
        })
        .catch((err) => {
          setError(err.message);
          setIsInitialized(false);
        })
        .finally(() => {
          setIsLoading(false);
        });
    }
  }, [credentials]);

  /**
   * Fetch credentials on mount
   */
  useEffect(() => {
    fetchCredentials();
    fetchStatus();
  }, [fetchCredentials, fetchStatus]);

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
   * Fetch satellite image
   */
  const fetchImage = useCallback(
    async (
      bbox: [number, number, number, number],
      date: Date,
      layer: LayerType = 'TRUE-COLOR'
    ) => {
      if (!isInitialized || !credentials) {
        setError('Sentinel Hub yapılandırılmamış. Ayarlar sayfasından yapılandırın.');
        return;
      }

      setIsLoading(true);
      setError(null);

      try {
        // End date = start date + 1 day for single day query
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
          credentials
        );

        // Revoke previous URL to prevent memory leaks
        if (previousImageUrl.current) {
          URL.revokeObjectURL(previousImageUrl.current);
        }

        // Create new object URL for the image
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
    [isInitialized, credentials]
  );

  /**
   * Fetch available dates for a location
   */
  const fetchAvailableDates = useCallback(
    async (bbox: [number, number, number, number], from: Date, to: Date) => {
      if (!isInitialized || !credentials) {
        return;
      }

      try {
        const dates = await getAvailableDates(bbox, from, to, credentials);
        setAvailableDates(dates);
      } catch (err) {
        console.error('Failed to fetch available dates:', err);
        setAvailableDates([]);
      }
    },
    [isInitialized, credentials]
  );

  /**
   * Refresh credentials from backend
   */
  const refreshCredentials = useCallback(async () => {
    setIsInitialized(false);
    await fetchCredentials();
    await fetchStatus();
  }, [fetchCredentials, fetchStatus]);

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
