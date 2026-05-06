/**
 * ScadaDataProvider — React context provider for SCADA HMI data.
 *
 * This module provides two API layers:
 *
 * 1. **Legacy API** (ScadaDataContext / useScadaData / useScadaDataOptional):
 *    Device-code-oriented live data via useScadaLiveData.  Retained for
 *    backward compatibility with older widget renderers.
 *
 * 2. **IDataProvider API** (ScadaRuntimeProvider / useDataProvider):
 *    Tag-oriented abstraction that selects the correct data source
 *    (simulation, live, hybrid) based on the operator store's mode.
 *    New widget code should use this layer exclusively.
 *
 * The <ScadaRuntimeProvider> component wraps <DataProviderRoot> and
 * automatically derives the provider type from the operator store:
 *   - operatorMode === false → 'simulation'
 *   - operatorMode === true  → 'live'
 *   - (future) hybrid mode   → 'hybrid'
 *
 * Both layers can coexist in the same component tree.
 */

import React, { createContext, useContext, useCallback, useRef, useState, useMemo } from 'react';
import { useScadaLiveData, type ConnectionStatus, type IoAlarmEvent } from '../hooks/useScadaLiveData';
import { DataProviderRoot } from '../providers/DataProviderContext';
import { useOperatorStore } from '../store/scada/operatorStore';
import type { DataProviderType, IDataProvider } from '../types/scada-runtime.types';

// Re-export the IDataProvider consumer hook from the providers layer so that
// consumers of this module get a single import path.
export { useDataProvider } from '../providers/DataProviderContext';
export type { IDataProvider };

/* ================================================================== */
/*  1. Legacy API (device-code-oriented)                               */
/* ================================================================== */

export interface ScadaDataContextValue {
  values: Record<string, Record<string, unknown>>;
  alarms: Record<string, IoAlarmEvent[]>;
  isConnected: boolean;
  connectionStatus: ConnectionStatus;
  getTagValue: (deviceCode: string, tagName: string) => unknown;
  subscribeTag: (deviceCode: string, tagName: string) => void;
  unsubscribeTag: (deviceCode: string, tagName: string) => void;
}

export const ScadaDataContext = createContext<ScadaDataContextValue | null>(null);

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

  const contextValue = useMemo<ScadaDataContextValue>(
    () => ({
      values,
      alarms,
      isConnected,
      connectionStatus,
      getTagValue,
      subscribeTag,
      unsubscribeTag,
    }),
    [values, alarms, isConnected, connectionStatus, getTagValue, subscribeTag, unsubscribeTag]
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

/**
 * Safe version of useScadaData that returns null when not inside a ScadaDataProvider.
 * Useful for components that render in both edit and preview modes.
 */
export function useScadaDataOptional(): ScadaDataContextValue | null {
  return useContext(ScadaDataContext);
}

/* ================================================================== */
/*  2. IDataProvider API (tag-oriented, mode-aware)                    */
/* ================================================================== */

interface ScadaRuntimeProviderProps {
  /** Override the automatic provider type selection. */
  providerType?: DataProviderType;
  children: React.ReactNode;
}

/**
 * ScadaRuntimeProvider — Wraps DataProviderRoot and auto-selects the
 * provider type based on operator mode from the Zustand store.
 *
 * Usage:
 *   <ScadaRuntimeProvider>
 *     <MyWidgetTree />
 *   </ScadaRuntimeProvider>
 *
 * Child components consume data via useDataProvider() from '../providers'.
 */
export function ScadaRuntimeProvider({
  providerType,
  children,
}: ScadaRuntimeProviderProps) {
  const operatorMode = useOperatorStore((s) => s.operatorMode);

  const resolvedType: DataProviderType = providerType ?? (operatorMode ? 'live' : 'simulation');

  return (
    <DataProviderRoot type={resolvedType}>
      {children}
    </DataProviderRoot>
  );
}

export default ScadaDataProvider;
