/**
 * useSentinelTiles Hook
 *
 * Browser state for Sentinel map layers. Credential verification and tile
 * delivery are owned by the backend marine data contract.
 */

import { useState, useCallback, useEffect } from 'react';
import { useAuth, graphqlClient } from '@aquaculture/shared-ui';

import { type LayerType } from '../services/sentinelHubService';

const SENTINEL_HUB_STATUS_QUERY = `
  query SentinelHubStatus {
    sentinelHubStatus {
      isConfigured
    }
  }
`;

export interface SentinelTilesState {
  isConfigured: boolean;
  layer: LayerType;
  date: Date;
  opacity: number;
  maxCloudCoverage: number;
  isLoading: boolean;
  error: string | null;
}

export interface UseSentinelTilesReturn extends SentinelTilesState {
  setLayer: (layer: LayerType) => void;
  setDate: (date: Date) => void;
  setOpacity: (opacity: number) => void;
  setMaxCloudCoverage: (coverage: number) => void;
  refreshConfig: () => Promise<void>;
  onLoadingChange: (isLoading: boolean) => void;
  onError: (error: string) => void;
}

export function useSentinelTiles(): UseSentinelTilesReturn {
  const { token: authToken } = useAuth();
  const [isConfigured, setIsConfigured] = useState(false);
  const [layer, setLayer] = useState<LayerType>('TRUE-COLOR');
  const [date, setDate] = useState<Date>(() => {
    const defaultDate = new Date();
    defaultDate.setDate(defaultDate.getDate() - 30);
    return defaultDate;
  });
  const [opacity, setOpacity] = useState(0.9);
  const [maxCloudCoverage, setMaxCloudCoverage] = useState(30);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshConfig = useCallback(async (): Promise<void> => {
    if (!authToken) {
      setIsConfigured(false);
      return;
    }
    setIsLoading(true);
    try {
      const data = await graphqlClient.request<{
        sentinelHubStatus: { isConfigured: boolean };
      }>(SENTINEL_HUB_STATUS_QUERY);
      setIsConfigured(data.sentinelHubStatus?.isConfigured ?? false);
      setError(null);
    } catch (err) {
      setIsConfigured(false);
      setError(err instanceof Error ? err.message : 'Sentinel Hub durumu alinamadi');
    } finally {
      setIsLoading(false);
    }
  }, [authToken]);

  useEffect(() => {
    void refreshConfig();
  }, [refreshConfig]);

  const onLoadingChange = useCallback((loading: boolean) => {
    setIsLoading(loading);
  }, []);

  const onError = useCallback((err: string) => {
    setError(err);
    setTimeout(() => setError(null), 5000);
  }, []);

  return {
    isConfigured,
    layer,
    date,
    opacity,
    maxCloudCoverage,
    isLoading,
    error,
    setLayer,
    setDate,
    setOpacity,
    setMaxCloudCoverage,
    refreshConfig,
    onLoadingChange,
    onError,
  };
}

export default useSentinelTiles;
