/**
 * T6 connection-state binding: the ScadaSocketService listener API drives the
 * useScadaConnectionState hook (useSyncExternalStore), including the
 * immediate current-state callback for late subscribers.
 */

import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, act, screen } from '@testing-library/react';

import { useScadaConnectionState } from '../useScadaConnectionState';
import { getScadaSocketService } from '../../services/ScadaSocketService';

function Probe() {
  const state = useScadaConnectionState();
  return <div data-testid="state">{state}</div>;
}

describe('T6 connection-state binding', () => {
  const service = getScadaSocketService();
  const internals = service as unknown as {
    _setConnectionState: (state: 'connected' | 'connecting' | 'disconnected' | 'error') => void;
    connectionStateListeners: Set<(s: string) => void>;
  };

  afterEach(() => {
    internals.connectionStateListeners.clear();
    internals._setConnectionState('disconnected'); // restore for other suites
  });

  it('hook value mirrors service transitions via the listener API', async () => {
    render(<Probe />);

    // Late subscriber receives the CURRENT state immediately.
    expect(screen.getByTestId('state').textContent).toBe(service.connectionState);

    // _setConnectionState updates the field AND notifies listeners — the
    // hook must re-render with the new value.
    await act(async () => {
      internals._setConnectionState('error');
    });
    expect(screen.getByTestId('state').textContent).toBe('error');

    await act(async () => {
      internals._setConnectionState('connected');
    });
    expect(screen.getByTestId('state').textContent).toBe('connected');
  });

  it('onConnectionStateChange returns an unsubscribe function', () => {
    const received: string[] = [];
    const unsubscribe = service.onConnectionStateChange((s) => received.push(s));
    expect(received).toEqual([service.connectionState]); // immediate callback

    unsubscribe();
    internals._setConnectionState('error');
    // No further notifications after unsubscribe (only the initial one).
    expect(received).toEqual(['disconnected']);
    internals._setConnectionState('disconnected'); // restore
  });
});
