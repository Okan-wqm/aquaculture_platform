/**
 * useSentinelTiles Hook
 *
 * Manages Sentinel Hub WMTS tile layer state including:
 * - WMTS Configuration (instanceId + token)
 * - Layer state (current layer, date, opacity)
 * - Loading and error states
 *
 * WMTS provides much faster tile loading than Processing API:
 * - Processing API: 2-5 seconds per tile
 * - WMTS: 100-200ms per tile
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { LayerType } from '../services/sentinelHubService';

// GraphQL queries
const SENTINEL_HUB_STATUS_QUERY = `
  query SentinelHubStatus {
    sentinelHubStatus {
      isConfigured
      clientIdMasked
      instanceIdMasked
      lastUsed
      usageCount
    }
  }
`;

const SENTINEL_HUB_WMTS_CONFIG_QUERY = `
  query SentinelHubWmtsConfig {
    sentinelHubWmtsConfig {
      instanceId
      accessToken
      expiresIn
    }
  }
`;

// Fallback: If no instanceId, use token-only query
const SENTINEL_HUB_TOKEN_QUERY = `
  query SentinelHubToken {
    sentinelHubToken {
      accessToken
      expiresIn
    }
  }
`;

export interface SentinelTilesState {
  // Configuration
  isConfigured: boolean;
  instanceId: string | null;
  token: string | null;
  tokenExpiry: Date | null;

  // Current layer settings
  layer: LayerType;
  date: Date;
  opacity: number;
  maxCloudCoverage: number;

  // Status
  isLoading: boolean;
  error: string | null;

  // WMTS support
  hasWmtsSupport: boolean; // True if instanceId is configured
}

export interface UseSentinelTilesReturn extends SentinelTilesState {
  // Actions
  setLayer: (layer: LayerType) => void;
  setDate: (date: Date) => void;
  setOpacity: (opacity: number) => void;
  setMaxCloudCoverage: (coverage: number) => void;
  refreshConfig: () => Promise<void>;

  // Callbacks for tile layer
  onLoadingChange: (isLoading: boolean) => void;
  onError: (error: string) => void;
}

export function useSentinelTiles(): UseSentinelTilesReturn {
  // Configuration state
  const [isConfigured, setIsConfigured] = useState(false);
  const [instanceId, setInstanceId] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [tokenExpiry, setTokenExpiry] = useState<Date | null>(null);
  const [hasWmtsSupport, setHasWmtsSupport] = useState(false);

  // Layer settings
  const [layer, setLayer] = useState<LayerType>('TRUE-COLOR');
  const [date, setDate] = useState<Date>(() => {
    // Default to 30 days ago (better chance of cloud-free imagery)
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d;
  });
  const [opacity, setOpacity] = useState(0.9);
  const [maxCloudCoverage, setMaxCloudCoverage] = useState(30);

  // Status
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Token refresh timer
  const tokenRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Check if Sentinel Hub is configured
   */
  const checkConfiguration = useCallback(async (): Promise<boolean> => {
    try {
      const authToken = localStorage.getItem('access_token');
      if (!authToken) {
        setIsConfigured(false);
        return false;
      }

      const response = await fetch('/graphql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ query: SENTINEL_HUB_STATUS_QUERY }),
      });

      const result = await response.json();
      const status = result.data?.sentinelHubStatus;
      const configured = status?.isConfigured ?? false;
      const hasInstance = !!status?.instanceIdMasked;

      setIsConfigured(configured);
      setHasWmtsSupport(hasInstance);

      return configured;
    } catch (err) {
      console.error('Failed to check Sentinel Hub configuration:', err);
      setIsConfigured(false);
      return false;
    }
  }, []);

  /**
   * Fetch WMTS config (instanceId + token) from backend
   */
  const fetchWmtsConfig = useCallback(async (): Promise<boolean> => {
    try {
      const authToken = localStorage.getItem('access_token');
      if (!authToken) {
        throw new Error('Oturum acmaniz gerekiyor');
      }

      const response = await fetch('/graphql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ query: SENTINEL_HUB_WMTS_CONFIG_QUERY }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error: ${response.status}`);
      }

      const result = await response.json();

      if (result.errors) {
        throw new Error(result.errors[0]?.message || 'WMTS config alinamadi');
      }

      const wmtsConfig = result.data?.sentinelHubWmtsConfig;

      if (wmtsConfig) {
        // WMTS is configured
        const expiry = new Date(Date.now() + (wmtsConfig.expiresIn - 60) * 1000);

        setInstanceId(wmtsConfig.instanceId);
        setToken(wmtsConfig.accessToken);
        setTokenExpiry(expiry);
        setHasWmtsSupport(true);
        setError(null);

        return true;
      } else {
        // WMTS not configured, try token-only fallback
        setInstanceId(null);
        setHasWmtsSupport(false);
        return false;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'WMTS config alinamadi';
      setError(message);
      setInstanceId(null);
      setToken(null);
      setTokenExpiry(null);
      setHasWmtsSupport(false);
      return false;
    }
  }, []);

  /**
   * Fallback: Fetch token only (for Processing API if WMTS not available)
   */
  const fetchTokenOnly = useCallback(async (): Promise<boolean> => {
    try {
      const authToken = localStorage.getItem('access_token');
      if (!authToken) {
        throw new Error('Oturum acmaniz gerekiyor');
      }

      const response = await fetch('/graphql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ query: SENTINEL_HUB_TOKEN_QUERY }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error: ${response.status}`);
      }

      const result = await response.json();

      if (result.errors) {
        throw new Error(result.errors[0]?.message || 'Token alinamadi');
      }

      const tokenResult = result.data?.sentinelHubToken;

      if (tokenResult) {
        const expiry = new Date(Date.now() + (tokenResult.expiresIn - 60) * 1000);

        setToken(tokenResult.accessToken);
        setTokenExpiry(expiry);
        setError(null);

        return true;
      }

      return false;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Token alinamadi';
      setError(message);
      setToken(null);
      setTokenExpiry(null);
      return false;
    }
  }, []);

  /**
   * Refresh configuration (WMTS or token-only)
   */
  const refreshConfig = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    try {
      // First try WMTS config
      const wmtsSuccess = await fetchWmtsConfig();

      // If WMTS not available, fall back to token-only
      if (!wmtsSuccess) {
        await fetchTokenOnly();
      }
    } finally {
      setIsLoading(false);
    }
  }, [fetchWmtsConfig, fetchTokenOnly]);

  /**
   * Schedule token refresh
   */
  const scheduleTokenRefresh = useCallback((expiry: Date) => {
    if (tokenRefreshTimer.current) {
      clearTimeout(tokenRefreshTimer.current);
    }

    const timeUntilRefresh = expiry.getTime() - Date.now();
    if (timeUntilRefresh > 0) {
      tokenRefreshTimer.current = setTimeout(() => {
        refreshConfig();
      }, timeUntilRefresh);
    }
  }, [refreshConfig]);

  /**
   * Initialize on mount
   */
  useEffect(() => {
    const init = async () => {
      const configured = await checkConfiguration();
      if (configured) {
        await refreshConfig();
      }
    };
    init();

    return () => {
      if (tokenRefreshTimer.current) {
        clearTimeout(tokenRefreshTimer.current);
      }
    };
  }, [checkConfiguration, refreshConfig]);

  /**
   * Schedule token refresh when expiry changes
   */
  useEffect(() => {
    if (tokenExpiry) {
      scheduleTokenRefresh(tokenExpiry);
    }
  }, [tokenExpiry, scheduleTokenRefresh]);

  /**
   * Loading change callback
   */
  const onLoadingChange = useCallback((loading: boolean) => {
    setIsLoading(loading);
  }, []);

  /**
   * Error callback
   */
  const onError = useCallback((err: string) => {
    setError(err);
    // Clear error after 5 seconds
    setTimeout(() => setError(null), 5000);
  }, []);

  return {
    // State
    isConfigured,
    instanceId,
    token,
    tokenExpiry,
    layer,
    date,
    opacity,
    maxCloudCoverage,
    isLoading,
    error,
    hasWmtsSupport,

    // Actions
    setLayer,
    setDate,
    setOpacity,
    setMaxCloudCoverage,
    refreshConfig,

    // Callbacks
    onLoadingChange,
    onError,
  };
}

export default useSentinelTiles;
