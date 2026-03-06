/**
 * ScadaDataProvider
 *
 * React Context provider that wraps useScadaLiveData for SCADA widgets.
 * All child components (widget renderers) can consume live data via useScadaData().
 */

import React, { createContext, useContext, useCallback, useRef, useState, useMemo } from 'react';
import { useScadaLiveData, type ConnectionStatus, type IoAlarmEvent } from '../hooks/useScadaLiveData';

export interface ScadaDataContextValue {
  values: Record<string, Record<string, any>>;
  alarms: IoAlarmEvent[];
  isConnected: boolean;
  connectionStatus: ConnectionStatus;
  getTagValue: (deviceCode: string, tagName: string) => any;
  subscribeTag: (deviceCode: string, tagName: string) => void;
  unsubscribeTag: (deviceCode: string, tagName: string) => void;
}

const ScadaDataContext = createContext<ScadaDataContextValue | null>(null);

interface ScadaDataProviderProps {
  initialDeviceCodes?: string[];
  enabled?: boolean;
  children: React.ReactNode;
}

export function ScadaDataProvider({ initialDeviceCodes = [], enabled = true, children }: ScadaDataProviderProps) {
  const [deviceCodes, setDeviceCodes] = useState<string[]>(initialDeviceCodes);
  const tagRegistryRef = useRef<Map<string, Set<string>>>(new Map());

  const { values, alarms, isConnected, connectionStatus, getTagValue } = useScadaLiveData({
    deviceCodes,
    enabled,
  });

  const subscribeTag = useCallback((deviceCode: string, _tagName: string) => {
    const registry = tagRegistryRef.current;
    if (!registry.has(deviceCode)) {
      registry.set(deviceCode, new Set());
    }
    registry.get(deviceCode)!.add(_tagName);

    setDeviceCodes((prev) => {
      if (prev.includes(deviceCode)) return prev;
      return [...prev, deviceCode];
    });
  }, []);

  const unsubscribeTag = useCallback((deviceCode: string, tagName: string) => {
    const registry = tagRegistryRef.current;
    const tags = registry.get(deviceCode);
    if (tags) {
      tags.delete(tagName);
      if (tags.size === 0) {
        registry.delete(deviceCode);
        setDeviceCodes((prev) => prev.filter((c) => c !== deviceCode));
      }
    }
  }, []);

  // Flatten alarms from all devices into a single array
  const flatAlarms = useMemo(() => {
    const all: IoAlarmEvent[] = [];
    for (const deviceAlarms of Object.values(alarms)) {
      all.push(...deviceAlarms);
    }
    return all;
  }, [alarms]);

  const contextValue = useMemo<ScadaDataContextValue>(
    () => ({
      values,
      alarms: flatAlarms,
      isConnected,
      connectionStatus,
      getTagValue,
      subscribeTag,
      unsubscribeTag,
    }),
    [values, flatAlarms, isConnected, connectionStatus, getTagValue, subscribeTag, unsubscribeTag]
  );

  return (
    <ScadaDataContext.Provider value={contextValue}>
      {children}
    </ScadaDataContext.Provider>
  );
}

export function useScadaData(): ScadaDataContextValue {
  const ctx = useContext(ScadaDataContext);
  if (!ctx) {
    throw new Error('useScadaData must be used within a <ScadaDataProvider>');
  }
  return ctx;
}

export default ScadaDataProvider;
