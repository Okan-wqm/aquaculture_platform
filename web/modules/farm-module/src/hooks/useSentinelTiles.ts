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
import { useAuth, graphqlClient } from '@aquaculture/shared-ui';
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

/**
 * SEC-C14: WMTS config query now returns only instanceId + expiresIn.
 * The accessToken field is hidden via @HideField() and never reaches the browser.
 * All tile requests are proxied through the backend (/api/sentinel-hub/wms/:layerId).
 */
const SENTINEL_HUB_WMTS_CONFIG_QUERY = `
  query SentinelHubWmtsConfig {
    sentinelHubWmtsConfig {
      instanceId
      expiresIn
    }
  }
`;

/**
 * SEC-C14: Token check query — only returns expiresIn to verify credentials work.
 */
const SENTINEL_HUB_TOKEN_CHECK_QUERY = `
  query SentinelHubToken {
    sentinelHubToken {
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
  const { token: authToken } = useAuth();

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
    if (!authToken) {
      setIsConfigured(false);
      return false;
    }
    try {
      const data = await graphqlClient.request<{
        sentinelHubStatus: {
          isConfigured: boolean;
          instanceIdMasked?: string | null;
        };
      }>(SENTINEL_HUB_STATUS_QUERY);

      const status = data.sentinelHubStatus;
      const configured = status?.isConfigured ?? false;
      const hasInstance = !!status?.instanceIdMasked;

      setIsConfigured(configured);
      setHasWmtsSupport(hasInstance);

      return configured;
    } catch (err) {
      if (import.meta.env.DEV) console.error('Failed to check Sentinel Hub configuration:', err);
      setIsConfigured(false);
      return false;
    }
  }, [authToken]);

  /**
   * SEC-C14: Fetch WMTS config (instanceId + expiresIn) from backend.
   * The accessToken is hidden via @HideField — it lives only on the backend.
   * All tile requests are routed through the backend proxy.
   */
  const fetchWmtsConfig = useCallback(async (): Promise<boolean> => {
    if (!authToken) return false;
    try {
      const data = await graphqlClient.request<{
        sentinelHubWmtsConfig: {
          instanceId: string;
          expiresIn: number;
        } | null;
      }>(SENTINEL_HUB_WMTS_CONFIG_QUERY);

      const wmtsConfig = data.sentinelHubWmtsConfig;

      if (wmtsConfig) {
        const expiry = new Date(Date.now() + (wmtsConfig.expiresIn - 60) * 1000);

        setInstanceId(wmtsConfig.instanceId);
        setToken('proxy-managed');
        setTokenExpiry(expiry);
        setHasWmtsSupport(true);
        setError(null);

        return true;
      } else {
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
  }, [authToken]);

  /**
   * SEC-C14: Verify that backend credentials are working (no token returned).
   * Used as fallback when WMTS instanceId is not configured.
   */
  const verifyCredentials = useCallback(async (): Promise<boolean> => {
    if (!authToken) return false;
    try {
      const data = await graphqlClient.request<{
        sentinelHubToken: { expiresIn: number } | null;
      }>(SENTINEL_HUB_TOKEN_CHECK_QUERY);

      const tokenResult = data.sentinelHubToken;

      if (tokenResult) {
        const expiry = new Date(Date.now() + (tokenResult.expiresIn - 60) * 1000);

        setToken('proxy-managed');
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
  }, [authToken]);

  /**
   * Refresh configuration (WMTS or token-only)
   */
  const refreshConfig = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    try {
      // First try WMTS config
      const wmtsSuccess = await fetchWmtsConfig();

      // If WMTS not available, fall back to credential verification
      if (!wmtsSuccess) {
        await verifyCredentials();
      }
    } finally {
      setIsLoading(false);
    }
  }, [fetchWmtsConfig, verifyCredentials]);

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
