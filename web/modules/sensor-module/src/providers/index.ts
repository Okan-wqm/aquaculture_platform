/**
 * providers/index.ts — Barrel export for the DataProvider system.
 *
 * Public API surface:
 *   - DataProviderContext, useDataProvider, DataProviderRoot  (context + root)
 *   - SimulationDataProviderInner                             (sim impl)
 *   - LiveDeviceDataProviderInner                             (live impl)
 *   - HybridDataProviderInner, HybridDataProviderContext,
 *     useHybridDataProvider                                   (hybrid impl)
 *
 * Internal service layer (also re-exported for direct use where needed):
 *   - ScadaSocketService, getScadaSocketService
 *   - TagSubscriptionManager, createTagSubscriptionManager
 */

// ── Context & root ────────────────────────────────────────────────────────────

export {
  DataProviderContext,
  useDataProvider,
  DataProviderRoot,
} from './DataProviderContext';

export type { DataProviderRootProps } from './DataProviderContext';

// ── Simulation provider ───────────────────────────────────────────────────────

export { SimulationDataProviderInner } from './SimulationDataProvider';

// ── Live device provider ──────────────────────────────────────────────────────

export { LiveDeviceDataProviderInner } from './LiveDeviceDataProvider';

// ── Hybrid provider ───────────────────────────────────────────────────────────

export {
  HybridDataProviderInner,
  HybridDataProviderContext,
  useHybridDataProvider,
} from './HybridDataProvider';

export type {
  TagSource,
  HybridDataProviderContextValue,
} from './HybridDataProvider';

// ── Socket service ────────────────────────────────────────────────────────────

export {
  ScadaSocketService,
  getScadaSocketService,
} from '../services/ScadaSocketService';

export type {
  ScadaEventPayloadMap,
  ScadaEventCallback,
} from '../services/ScadaSocketService';

// ── Subscription manager ──────────────────────────────────────────────────────

export {
  TagSubscriptionManager,
  createTagSubscriptionManager,
} from '../services/TagSubscriptionManager';


// ── Shared runtime types (re-exported for consumers) ─────────────────────────

export type {
  IDataProvider,
  DataProviderType,
  DataProviderConnectionState,
  TagValueChange,
  TagQuality,
  HistoricalDataResult,
  HistoricalDataPoint,
} from '../types/scada-runtime.types';
