/**
 * SimulationDataProvider
 *
 * Provides the same ScadaDataContext used by ScadaDataProvider but backed
 * by the simulation store's simTagValues instead of live device data.
 * Widget renderers work unchanged — they call getTagValue(deviceCode, tagName)
 * and receive simulated values when deviceCode === "__sim__".
 *
 * NOTE: getTagValue is always called during render by widget renderers.
 * Do not cache it across renders — the closure captures the current simTagValues.
 */

import React, { useMemo } from 'react';
import { useScadaPackageStore } from '../store/scada';
import type { ConnectionStatus } from '../hooks/useScadaLiveData';

// Re-use the exact same context so widget renderers work unmodified
import { ScadaDataContext } from './ScadaDataProvider';
import type { ScadaDataContextValue } from './ScadaDataProvider';

interface SimulationDataProviderProps {
  children: React.ReactNode;
}

const SIM_CONNECTION_STATUS: ConnectionStatus = 'connected';

export function SimulationDataProvider({ children }: SimulationDataProviderProps) {
  // Direct selector — immer structural sharing already guarantees reference stability
  const simTagValues = useScadaPackageStore((s) => s.simTagValues);

  const contextValue = useMemo<ScadaDataContextValue>(
    () => ({
      values: { __sim__: simTagValues },
      alarms: {},
      isConnected: true,
      connectionStatus: SIM_CONNECTION_STATUS,
      getTagValue: (_deviceCode: string, tagName: string) => simTagValues[tagName],
      subscribeTag: () => {},
      unsubscribeTag: () => {},
    }),
    [simTagValues],
  );

  return (
    <ScadaDataContext.Provider value={contextValue}>
      {children}
    </ScadaDataContext.Provider>
  );
}
