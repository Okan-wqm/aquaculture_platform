/**
 * StableModeProvider
 *
 * Wraps SCADA canvas children with the appropriate data context based on
 * the current builder mode (edit / preview / simulation) WITHOUT changing
 * the React element tree structure.
 *
 * Problem solved:
 * Previously, ScadaPackageBuilderPage used a ternary to render one of three
 * different subtrees depending on mode:
 *   - edit:       <ScreenCanvas />
 *   - preview:    <ScadaDataProvider><ScreenCanvas /></ScadaDataProvider>
 *   - simulation: <SimulationDataProvider><ScreenCanvas /></SimulationDataProvider>
 *
 * Because each branch has a different parent element type, React treats them
 * as entirely different subtrees on reconciliation. This causes the old
 * ScreenCanvas to UNMOUNT and a new one to MOUNT, destroying all local
 * ReactFlow state (dragged widget positions, viewport, selection).
 *
 * Solution:
 * This component always renders the same tree structure — a single context
 * provider — and only changes the VALUE it provides. In edit mode, the
 * context value is null (no data provider). In preview mode it provides
 * live device data. In simulation mode it provides simulated tag values.
 * The children (ScreenCanvas) are never unmounted.
 */

import React, { useMemo, useState, useCallback, useRef } from 'react';
import { ScadaDataContext } from '../../context/ScadaDataProvider';
import type { ScadaDataContextValue } from '../../context/ScadaDataProvider';
import type { ConnectionStatus } from '../../hooks/useScadaLiveData';
import { useScadaLiveData } from '../../hooks/useScadaLiveData';
import { useScadaPackageStore } from '../../store/scada';
import type { BuilderMode } from '../../pages/scada/ScadaBuilderToolbar';

interface StableModeProviderProps {
  mode: BuilderMode;
  /** Device code for live data in preview mode. null when not available. */
  deviceCode: string | null;
  children: React.ReactNode;
}

const NOOP = () => {};
const SIM_CONNECTION_STATUS: ConnectionStatus = 'connected';

/**
 * Internal sub-component that subscribes to live device data.
 * Only renders when mode === 'preview' AND a deviceCode is available.
 * Returns the context value for ScadaDataContext.
 *
 * Extracted so the useScadaLiveData hook only fires when actually needed,
 * but the provider tree structure remains identical across modes.
 */
function usePreviewData(
  enabled: boolean,
  deviceCode: string | null,
): ScadaDataContextValue | null {
  const [deviceCodes, setDeviceCodes] = useState<string[]>(
    deviceCode ? [deviceCode] : [],
  );
  const tagRegistryRef = useRef<Map<string, Set<string>>>(new Map());

  // Keep deviceCodes in sync with prop changes
  React.useEffect(() => {
    if (deviceCode) {
      setDeviceCodes((prev) => {
        if (prev.length === 1 && prev[0] === deviceCode) return prev;
        return [deviceCode];
      });
    } else {
      setDeviceCodes([]);
    }
  }, [deviceCode]);

  const { values, alarms, isConnected, connectionStatus, getTagValue } =
    useScadaLiveData({
      deviceCodes: enabled ? deviceCodes : [],
      enabled,
    });

  const subscribeTag = useCallback(
    (dc: string, tagName: string) => {
      const registry = tagRegistryRef.current;
      if (!registry.has(dc)) {
        registry.set(dc, new Set());
      }
      registry.get(dc)!.add(tagName);
      setDeviceCodes((prev) => {
        if (prev.includes(dc)) return prev;
        return [...prev, dc];
      });
    },
    [],
  );

  const unsubscribeTag = useCallback(
    (dc: string, tagName: string) => {
      const registry = tagRegistryRef.current;
      const tags = registry.get(dc);
      if (tags) {
        tags.delete(tagName);
        if (tags.size === 0) {
          registry.delete(dc);
          setDeviceCodes((prev) => prev.filter((c) => c !== dc));
        }
      }
    },
    [],
  );

  return useMemo<ScadaDataContextValue | null>(() => {
    if (!enabled) return null;
    return {
      values,
      alarms,
      isConnected,
      connectionStatus,
      getTagValue,
      subscribeTag,
      unsubscribeTag,
    };
  }, [
    enabled,
    values,
    alarms,
    isConnected,
    connectionStatus,
    getTagValue,
    subscribeTag,
    unsubscribeTag,
  ]);
}

function useSimulationData(enabled: boolean): ScadaDataContextValue | null {
  const simTagValues = useScadaPackageStore((s) => s.simTagValues);

  return useMemo<ScadaDataContextValue | null>(() => {
    if (!enabled) return null;
    return {
      values: { __sim__: simTagValues },
      alarms: {},
      isConnected: true,
      connectionStatus: SIM_CONNECTION_STATUS,
      getTagValue: (_deviceCode: string, tagName: string) =>
        simTagValues[tagName],
      subscribeTag: NOOP,
      unsubscribeTag: NOOP,
    };
  }, [enabled, simTagValues]);
}

/**
 * Always renders:
 *   <ScadaDataContext.Provider value={...}>
 *     {children}
 *   </ScadaDataContext.Provider>
 *
 * The value changes based on mode, but the tree structure stays identical,
 * so React never unmounts the children.
 */
export const StableModeProvider: React.FC<StableModeProviderProps> = ({
  mode,
  deviceCode,
  children,
}) => {
  const isPreview = mode === 'preview' && !!deviceCode;
  const isSimulation = mode === 'simulation';

  const previewData = usePreviewData(isPreview, deviceCode);
  const simulationData = useSimulationData(isSimulation);

  // Determine context value: simulation > preview > null (edit mode)
  const contextValue = isSimulation
    ? simulationData
    : isPreview
      ? previewData
      : null;

  return (
    <ScadaDataContext.Provider value={contextValue}>
      {children}
    </ScadaDataContext.Provider>
  );
};
