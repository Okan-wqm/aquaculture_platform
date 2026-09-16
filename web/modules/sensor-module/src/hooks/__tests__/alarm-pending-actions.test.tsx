/**
 * A2 regression (Plan 2): server alarm actions (toast/popup/setView) must
 * reach the operator UI. The queue in alarmRuntimeSlice.pendingActions may
 * be drained ONLY by a `processActions: true` mount (OperatorBootstrap);
 * passive mounts (AlarmPanel / AlarmSummaryBar) must leave it intact.
 */

import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';

import { useScadaPackageStore } from '../../store/scada/createScadaStore';
import { useAlarmRuntime } from '../useAlarmRuntime';

// Mock the socket service so OperatorBootstrap can mount without a socket.
type Handler = (payload: unknown) => void;
const handlers = new Map<string, Handler>();
const serviceMock = {
  connect: vi.fn(),
  acquire: vi.fn(),
  release: vi.fn(),
  on: vi.fn((event: string, cb: Handler) => handlers.set(event, cb)),
  off: vi.fn((event: string) => handlers.delete(event)),
  queryAlarmHistory: vi.fn(),
};
vi.mock('../../services/ScadaSocketService', () => ({
  getScadaSocketService: () => serviceMock,
}));

import { OperatorBootstrap } from '../../components/scada-operator/OperatorBootstrap';

function enqueue(action: Record<string, unknown>): void {
  // updateAlarmStatus merges pendingActions from the server summary.
  useScadaPackageStore.getState().updateAlarmStatus({
    critical: 1,
    high: 0,
    warning: 0,
    info: 0,
    activeAlarms: [],
    pendingActions: [action],
  } as never);
}

describe('A2 alarm pendingActions reach the operator UI', () => {
  beforeEach(() => {
    useScadaPackageStore.getState().reset();
    handlers.clear();
    serviceMock.connect.mockClear();
    serviceMock.acquire.mockClear();
    serviceMock.release.mockClear();
  });

  it('toastMessage action opens a toast overlay with the message + severity', async () => {
    render(
      <OperatorBootstrap packageId="pkg-a2" dataProviderType="live">
        <div />
      </OperatorBootstrap>,
    );
    await waitFor(() => expect(handlers.size).toBeGreaterThan(0));

    enqueue({ type: 'toastMessage', message: 'Pump overheating', toastType: 'warning' });
    await waitFor(() => {
      const overlay = useScadaPackageStore
        .getState()
        .activeOverlays.find((o) => o.type === 'toast');
      expect(overlay?.message).toBe('Pump overheating');
      expect(overlay?.severity).toBe('warning');
    });
  });

  it('popup action opens a dialog overlay with the message', async () => {
    render(
      <OperatorBootstrap packageId="pkg-a2b" dataProviderType="live">
        <div />
      </OperatorBootstrap>,
    );
    await waitFor(() => expect(handlers.size).toBeGreaterThan(0));

    enqueue({ type: 'popup', message: 'Critical fault on tank 3' });
    await waitFor(() => {
      const overlay = useScadaPackageStore
        .getState()
        .activeOverlays.find((o) => o.type === 'dialog');
      expect(overlay?.message).toBe('Critical fault on tank 3');
    });
  });

  it('setView action switches the active screen', async () => {
    render(
      <OperatorBootstrap packageId="pkg-a2c" dataProviderType="live">
        <div />
      </OperatorBootstrap>,
    );
    await waitFor(() => expect(handlers.size).toBeGreaterThan(0));

    useScadaPackageStore.setState((s) => {
      s.screens = [
        { id: 'scr-a', name: 'A' },
        { id: 'scr-b', name: 'B' },
      ] as never;
      s.activeScreenId = 'scr-a';
    });
    enqueue({ type: 'setView', viewId: 'scr-b' });
    await waitFor(() => {
      expect(useScadaPackageStore.getState().activeScreenId).toBe('scr-b');
    });
  });

  it('a passive mount (no processActions) does NOT drain the queue', async () => {
    const Passive: React.FC = () => {
      useAlarmRuntime(); // AlarmPanel-style: read-only
      return <div>passive</div>;
    };
    render(<Passive />);

    enqueue({ type: 'toastMessage', message: 'queued', toastType: 'info' });
    // Give the passive effect a tick — the queue must survive.
    await new Promise((r) => setTimeout(r, 30));
    expect(useScadaPackageStore.getState().pendingActions.length).toBe(1);
  });
});
