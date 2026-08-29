/**
 * DataProviderContext — React context for the IDataProvider abstraction.
 *
 * Provides:
 *   - DataProviderContext: the raw React context holding an IDataProvider
 *   - useDataProvider(): hook to consume the provider
 *   - DataProviderRoot: component that selects the correct provider
 *     implementation based on the `type` prop and wraps children.
 *
 * Provider switching (e.g. simulation → live → hybrid) is handled by
 * swapping the `type` prop on DataProviderRoot; the context value updates
 * automatically and all consumers re-render with the new source.
 */

import React, { createContext, useContext, type ReactNode } from 'react';
import type { IDataProvider, DataProviderType } from '../types/scada-runtime.types';

// ── Context ───────────────────────────────────────────────────────────────────

/**
 * The React context that carries the active IDataProvider.
 * Initialised with a sentinel (null!) — consuming outside a provider throws
 * a clear error via useDataProvider().
 */
export const DataProviderContext = createContext<IDataProvider>(null!);
DataProviderContext.displayName = 'DataProviderContext';

// ── Consumer hook ─────────────────────────────────────────────────────────────

/**
 * useDataProvider — consume the nearest IDataProvider from context.
 *
 * Throws if used outside a <DataProviderRoot> (or equivalent provider).
 * All returned references are stable between renders unless the underlying
 * provider switches.
 */
export function useDataProvider(): IDataProvider {
  const provider = useContext(DataProviderContext);
  if (provider === null || provider === undefined) {
    throw new Error('useDataProvider() must be called inside a <DataProviderRoot> tree.');
  }
  return provider;
}

// ── DataProviderRoot ──────────────────────────────────────────────────────────

/**
 * Props for DataProviderRoot.
 *
 * type     — Which data source to activate: 'simulation' | 'live' | 'hybrid'
 * children — Subtree that will receive the provider via context
 */
export interface DataProviderRootProps {
  type: DataProviderType;
  children: ReactNode;
}

// Stable component identities are required across provider transitions. A
// React.lazy call made during render creates a new component type whenever the
// selected provider changes and can restart a pending import or remount state.
const SimulationDataProvider = React.lazy(() =>
  import('./SimulationDataProvider').then((module) => ({
    default: module.SimulationDataProviderInner,
  })),
);

const LiveDeviceDataProvider = React.lazy(() =>
  import('./LiveDeviceDataProvider').then((module) => ({
    default: module.LiveDeviceDataProviderInner,
  })),
);

const HybridDataProvider = React.lazy(() =>
  import('./HybridDataProvider').then((module) => ({
    default: module.HybridDataProviderInner,
  })),
);

function selectDataProvider(type: DataProviderType) {
  switch (type) {
    case 'simulation':
      return SimulationDataProvider;
    case 'live':
      return LiveDeviceDataProvider;
    case 'hybrid':
      return HybridDataProvider;
    default: {
      const exhaustive: never = type;
      throw new Error(`Unknown DataProviderType: ${String(exhaustive)}`);
    }
  }
}

/**
 * DataProviderRoot — Selects the appropriate provider implementation and
 * injects it into the subtree via DataProviderContext.
 *
 * Import the three concrete provider components lazily so that heavy
 * WebSocket / simulation code is only loaded when actually needed.
 */
export const DataProviderRoot: React.FC<DataProviderRootProps> = ({ type, children }) => {
  // Each *InnerProvider component creates the IDataProvider and returns the
  // matching DataProviderContext.Provider around children.
  const Inner = selectDataProvider(type);

  return (
    <React.Suspense fallback={null}>
      <Inner>{children}</Inner>
    </React.Suspense>
  );
};
