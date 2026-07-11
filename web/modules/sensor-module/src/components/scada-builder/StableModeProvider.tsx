/**
 * StableModeProvider
 *
 * Wraps SCADA canvas children with the canonical Layer-B data provider
 * (`DataProviderRoot` — the same `IDataProvider` chain the operator runtime
 * uses) selected by the current builder mode:
 *
 *   - edit / simulation → `type="simulation"` (values from the store's
 *     simTagValues; no network). Both modes use the SAME provider type, so
 *     the common edit⇄simulation toggle never changes the element tree and
 *     ScreenCanvas is not remounted (ReactFlow drag state is preserved).
 *   - preview            → `type="live"` (values from the tenant-fenced
 *     `/scada` socket). Entering/leaving live preview switches the provider
 *     type and remounts the canvas — acceptable because widget positions
 *     live in the store (restored on remount) and you do not drag in the
 *     read-only preview.
 *
 * This replaces the retired legacy `ScadaDataContext` + `useScadaLiveData`
 * (device-code Layer-A) path — the sensor module now has a single live-data
 * plane. Widgets read values via `useRealtimeData` keyed by the device-local
 * tag id `getWidgetTagBinding` yields, identical to the operator.
 */

import React from 'react';

import { DataProviderRoot } from '../../providers/DataProviderContext';
import type { BuilderMode } from '../../pages/scada/ScadaBuilderToolbar';

interface StableModeProviderProps {
  mode: BuilderMode;
  children: React.ReactNode;
}

export const StableModeProvider: React.FC<StableModeProviderProps> = ({
  mode,
  children,
}) => {
  // preview → live socket; edit + simulation → the passive store-backed
  // simulation provider (same type keeps edit⇄simulation remount-free).
  const providerType = mode === 'preview' ? 'live' : 'simulation';

  return <DataProviderRoot type={providerType}>{children}</DataProviderRoot>;
};
