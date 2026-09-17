/**
 * T5 control-contract test: a knob/slider write in OPERATOR mode must reach
 * the data provider's writeTagValue with the CANONICAL tag binding
 * (getWidgetTagBinding precedence: tagRef → tagName → tag → tagId), not the
 * historical "command:tagId" string protocol (deleted).
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';

import { DataProviderContext } from '../../../providers';
import type { IDataProvider } from '../../../types/scada-runtime.types';
import { RuntimeWidgetRenderer } from '../widgets/RuntimeWidgetRenderer';
import { useScadaPackageStore } from '../../../store/scada/createScadaStore';

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

describe('T5 command router: slider/knob writes (operator mode)', () => {
  beforeEach(() => {
    useScadaPackageStore.getState().reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('routes a slider setValue to the canonical tag binding via the provider', async () => {
    const { provider, writeTagValue } = makeMockProvider();

    const { container } = render(
      <DataProviderContext.Provider value={provider}>
        <RuntimeWidgetRenderer
          widgetType="slider"
          // canonical binding precedence: tagRef wins over tagId
          config={{ tagRef: 'DEV01/pump_speed', tagId: 'WRONG_TAG', label: 'Pump', min: 0, max: 100 }}
          tagIds={['pump_speed']}
          position={{ x: 0, y: 0, w: 200, h: 80 }}
        />
      </DataProviderContext.Provider>,
    );

    // Builder renderers are lazy-loaded through WidgetRenderer/Suspense —
    // wait for the real input to mount.
    const input = await waitFor(
      () => {
        const el = container.querySelector('input[type="range"]');
        expect(el).not.toBeNull();
        return el as HTMLInputElement;
      },
      { timeout: 3000 },
    );

    fireEvent.change(input, { target: { value: '73' } });

    await waitFor(() => {
      expect(writeTagValue).toHaveBeenCalledTimes(1);
    });
    // Canonical binding reduced to the device-LOCAL tag name.
    expect(writeTagValue).toHaveBeenCalledWith('pump_speed', 73);
  });

  it('falls back through the legacy binding keys (tagName) when tagRef is absent', async () => {
    const { provider, writeTagValue } = makeMockProvider();

    const { container } = render(
      <DataProviderContext.Provider value={provider}>
        <RuntimeWidgetRenderer
          widgetType="slider"
          config={{ tagName: 'tank_level', label: 'Tank', min: 0, max: 10 }}
          tagIds={['tank_level']}
          position={{ x: 0, y: 0, w: 200, h: 80 }}
        />
      </DataProviderContext.Provider>,
    );

    const input = await waitFor(() => {
      const el = container.querySelector('input[type="range"]');
      expect(el).not.toBeNull();
      return el as HTMLInputElement;
    });
    fireEvent.change(input, { target: { value: '4' } });

    await waitFor(() => {
      expect(writeTagValue).toHaveBeenCalledWith('tank_level', 4);
    });
  });

  it('shows the inline confirm dialog (never window.confirm) when config.requiresConfirm', async () => {
    const { provider, writeTagValue } = makeMockProvider();
    const confirmSpy = vi.spyOn(window, 'confirm');

    const { container } = render(
      <DataProviderContext.Provider value={provider}>
        <RuntimeWidgetRenderer
          widgetType="slider"
          config={{ tagName: 'dosing_rate', label: 'Dosing', requiresConfirm: true, min: 0, max: 100 }}
          tagIds={['dosing_rate']}
          position={{ x: 0, y: 0, w: 200, h: 80 }}
        />
      </DataProviderContext.Provider>,
    );

    const input = await waitFor(() => {
      const el = container.querySelector('input[type="range"]');
      expect(el).not.toBeNull();
      return el as HTMLInputElement;
    });

    fireEvent.change(input, { target: { value: '55' } });

    // Confirm UI appears inline; window.confirm is never used.
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(writeTagValue).not.toHaveBeenCalled();

    // Confirm → write flows through.
    fireEvent.click(
      Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Confirm')!,
    );
    await waitFor(() => {
      expect(writeTagValue).toHaveBeenCalledWith('dosing_rate', 55);
    });
    confirmSpy.mockRestore();
  });
});
