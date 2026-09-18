/**
 * useScadaConnectionState — React binding for the ScadaSocketService
 * connection state (T6).
 *
 * The service historically kept `_connectionState` as a private field with
 * no subscription surface, so React could not observe disconnects. The
 * service now exposes onConnectionStateChange(); this hook adapts it to
 * useSyncExternalStore so any component (e.g. the COMMS LOST banner)
 * re-renders on state transitions without polling.
 */

import { useCallback, useSyncExternalStore } from 'react';

import { getScadaSocketService } from '../services/ScadaSocketService';
import type { DataProviderConnectionState } from '../types/scada-runtime.types';

export function useScadaConnectionState(): DataProviderConnectionState {
  const service = getScadaSocketService();

  // Stable subscribe/unsubscribe pair so useSyncExternalStore does not
  // resubscribe on every render.
  const subscribe = useCallback(
    (callback: () => void): (() => void) => service.onConnectionStateChange(callback),
    [service],
  );

  const getSnapshot = useCallback(
    (): DataProviderConnectionState => service.connectionState,
    [service],
  );

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
