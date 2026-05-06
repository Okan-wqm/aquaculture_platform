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

import React, {
  createContext,
  useContext,
  useMemo,
  type ReactNode,
} from 'react';
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
    throw new Error(
      'useDataProvider() must be called inside a <DataProviderRoot> tree.',
    );
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

/**
 * DataProviderRoot — Selects the appropriate provider implementation and
 * injects it into the subtree via DataProviderContext.
 *
 * Import the three concrete provider components lazily so that heavy
 * WebSocket / simulation code is only loaded when actually needed.
 */
export const DataProviderRoot: React.FC<DataProviderRootProps> = ({
  type,
  children,
}) => {
  // Inline lazy imports so only the needed chunk loads.
  // Each *InnerProvider component is responsible for creating the IDataProvider
  // and returning <DataProviderContext.Provider value={...}>{children}</DataProviderContext.Provider>
  const Inner = useMemo(() => {
    switch (type) {
      case 'simulation':
        return React.lazy(() =>
          import('./SimulationDataProvider').then((m) => ({
            default: m.SimulationDataProviderInner,
          })),
        );
      case 'live':
        return React.lazy(() =>
          import('./LiveDeviceDataProvider').then((m) => ({
            default: m.LiveDeviceDataProviderInner,
          })),
        );
      case 'hybrid':
        return React.lazy(() =>
          import('./HybridDataProvider').then((m) => ({
            default: m.HybridDataProviderInner,
          })),
        );
      default: {
        // TypeScript exhaustiveness guard; never reached at runtime.
        const _exhaustive: never = type;
        throw new Error(`Unknown DataProviderType: ${String(_exhaustive)}`);
      }
    }
  }, [type]);

  return (
    <React.Suspense fallback={null}>
      <Inner>{children}</Inner>
    </React.Suspense>
  );
};
