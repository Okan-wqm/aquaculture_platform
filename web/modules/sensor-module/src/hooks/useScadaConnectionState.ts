/**
 * useScadaConnectionState — React binding for the SCADA socket's connection
 * state.
 *
 * The service kept `_connectionState` as a private field with a getter and no
 * observer, so nothing in React learned that the link had dropped: a provider
 * read the getter during render and an operator screen went on painting the
 * last values it had received. `onConnectionStateChange` is the subscription
 * that was missing; this hook adapts it to `useSyncExternalStore`, so any
 * component — the COMMS LOST banner above all — re-renders on a transition
 * without polling for it.
 */
import { useCallback, useSyncExternalStore } from 'react';

import { getScadaSocketService } from '../services/ScadaSocketService';
import type { DataProviderConnectionState } from '../types/scada-runtime.types';

export function useScadaConnectionState(): DataProviderConnectionState {
  const service = getScadaSocketService();

  // Stable subscribe/getSnapshot pair, so useSyncExternalStore does not
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
