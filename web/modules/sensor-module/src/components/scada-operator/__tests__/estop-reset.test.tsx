/**
 * A3 regression (Plan 2): a latched E-STOP must have a RESET path.
 *  - Activation: hold → inline confirm → affected tags written to safe value
 *    + latch (frame outline + RESET button appears).
 *  - Reset WITHOUT resetRequiresPin: one click clears the latch (audited).
 *  - Reset WITH resetRequiresPin: server-side PIN elevation gates the
 *    release; the latch survives until the PIN verifies.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';

import { DataProviderContext } from '../../../providers';
import type { IDataProvider } from '../../../types/scada-runtime.types';
import { RuntimeWidgetRenderer } from '../widgets/RuntimeWidgetRenderer';
import { useScadaPackageStore } from '../../../store/scada/createScadaStore';

const verifyPin = vi.fn();
vi.mock('../../../services/ScadaSocketService', () => ({
  getScadaSocketService: () => ({
    on: () => {},
    off: () => {},
    verifyPin,
  }),
}));

function makeMockProvider() {
  const writeTagValue = vi.fn(async () => {});
  const provider: IDataProvider = {
    subscribeToTags: vi.fn(),
    unsubscribeFromTags: vi.fn(),
    writeTagValue,
    getTagValue: () => null,
    getTagSnapshot: () => ({}),
    queryHistory: async () => ({ data: {} }),
    connectionState: 'connected',
  };
  return { provider, writeTagValue };
}

async function activateEStop(container: HTMLElement): Promise<void> {
  const circle = await waitFor(
    () => {
      // The interactive hold surface is the transparent overlay circle.
      const el = container.querySelector('svg circle[fill="transparent"]');
      expect(el).not.toBeNull();
      return el as SVGCircleElement;
    },
    { timeout: 3000 },
  );
  fireEvent.pointerDown(circle);
  // holdDuration=50ms — the rAF loop fires the command mid-hold; the router
  // gates E-stop behind the inline confirm dialog (aria-label "Confirm command").
  const confirm = await waitFor(
    () => {
      const dialog = container.querySelector('[aria-label="Confirm command"]');
      expect(dialog).toBeTruthy();
      const btn = [...(dialog?.querySelectorAll('button') ?? [])].find((b) =>
        /confirm/i.test(b.textContent ?? ''),
      );
      expect(btn).toBeTruthy();
      return btn as HTMLButtonElement;
    },
    { timeout: 2000 },
  );
  fireEvent.pointerUp(circle);
  fireEvent.click(confirm);
}

function findResetButton(container: HTMLElement): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((b) =>
    /reset e-stop/i.test(b.textContent ?? ''),
  );
}

describe('A3 E-STOP reset flow', () => {
  beforeEach(() => {
    useScadaPackageStore.getState().reset();
    // Control writes are role-gated: a viewer would be diverted to the PIN
    // dialog. Give the session the server-authoritative admin role.
    useScadaPackageStore.getState().setCurrentUserRole('admin');
    verifyPin.mockReset();
    verifyPin.mockResolvedValue({ valid: true });
  });

  it('activation writes safe values, latches, and reset clears the latch without PIN', async () => {
    const { provider, writeTagValue } = makeMockProvider();
    useScadaPackageStore.setState((s) => {
      s.controlPermissions = {
        securityLevels: { pin: [], none: [], confirm: [] },
        emergencyStop: { holdDuration: 50, affectedTags: ['DEV01/pump'], resetRequiresPin: false },
      } as never;
    });

    const { container } = render(
      <DataProviderContext.Provider value={provider}>
        <RuntimeWidgetRenderer
          widgetType="emergencyStop"
          config={{ label: 'E-STOP', holdDuration: 50 }}
          tagIds={[]}
          position={{ x: 0, y: 0, w: 160, h: 160 }}
        />
      </DataProviderContext.Provider>,
    );

    await activateEStop(container);

    await waitFor(() => {
      expect(writeTagValue).toHaveBeenCalledWith('DEV01/pump', 0);
    });
    const reset = await waitFor(() => {
      const b = findResetButton(container);
      expect(b).toBeTruthy();
      return b as HTMLButtonElement;
    });
    expect(container.firstChild).toBeTruthy();

    fireEvent.click(reset);
    await waitFor(() => {
      expect(findResetButton(container)).toBeUndefined();
    });
  });

  it('resetRequiresPin=true gates the release behind PIN verification', async () => {
    const { provider } = makeMockProvider();
    useScadaPackageStore.setState((s) => {
      s.packageId = 'pkg-a3-pin';
      s.controlPermissions = {
        securityLevels: { pin: [], none: [], confirm: [] },
        emergencyStop: { holdDuration: 50, affectedTags: [], resetRequiresPin: true },
      } as never;
    });

    const { container } = render(
      <DataProviderContext.Provider value={provider}>
        <RuntimeWidgetRenderer
          widgetType="emergencyStop"
          config={{ label: 'E-STOP', holdDuration: 50 }}
          tagIds={[]}
          position={{ x: 0, y: 0, w: 160, h: 160 }}
        />
      </DataProviderContext.Provider>,
    );

    await activateEStop(container);
    const reset = await waitFor(() => {
      const b = findResetButton(container);
      expect(b).toBeTruthy();
      return b as HTMLButtonElement;
    });

    fireEvent.click(reset);

    // PIN dialog appears; the latch (reset affordance) is still up.
    const pinInput = await waitFor(() => {
      const el = container.querySelector('input[type="password"]');
      expect(el).toBeTruthy();
      return el as HTMLInputElement;
    });
    expect(findResetButton(container)).toBeTruthy();

    fireEvent.change(pinInput, { target: { value: '123456' } });
    fireEvent.keyDown(pinInput, { key: 'Enter' });

    await waitFor(() => {
      expect(verifyPin).toHaveBeenCalled();
      expect(findResetButton(container)).toBeUndefined();
    });
  });
});
