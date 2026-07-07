import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, beforeEach } from 'vitest';

import { useScadaPackageStore } from '../../../store/scada';
import { useRealtimeData } from '../../../hooks/useRealtimeData';
import { StableModeProvider } from '../StableModeProvider';

/**
 * 6a — the builder preview canvas now reads live values through the
 * canonical Layer-B chain (DataProviderRoot + useRealtimeData), the same
 * one the operator runtime uses. These tests pin that StableModeProvider
 * mounts a working IDataProvider for each mode and that a consuming child
 * resolves a simulation tag value by the device-local key
 * `getWidgetTagBinding` yields — no legacy ScadaDataContext involved.
 */

function Probe({ tagId }: { tagId: string }): React.ReactElement {
  const { values, isConnected } = useRealtimeData([tagId]);
  return (
    <div>
      <span data-testid="connected">{String(isConnected)}</span>
      <span data-testid="value">{String(values[tagId]?.value ?? 'none')}</span>
    </div>
  );
}

describe('StableModeProvider — Layer-B single data plane', () => {
  beforeEach(() => {
    useScadaPackageStore.setState({ simTagValues: {} });
  });

  it('edit/simulation mode mounts the simulation provider and reads sim tag values', async () => {
    useScadaPackageStore.setState({ simTagValues: { water_temp: 21.5 } });

    render(
      <StableModeProvider mode="simulation">
        <Probe tagId="water_temp" />
      </StableModeProvider>,
    );

    // DataProviderRoot lazy-loads the simulation provider (Suspense).
    await waitFor(() => expect(screen.getByTestId('connected').textContent).toBe('true'));
    await waitFor(() => expect(screen.getByTestId('value').textContent).toBe('21.5'));
  });

  it('edit mode also mounts a provider (no throw) so ScreenCanvas can call useRealtimeData', async () => {
    render(
      <StableModeProvider mode="edit">
        <Probe tagId="water_temp" />
      </StableModeProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('connected')).toBeTruthy());
    // No sim value set → reads nothing, but the provider is present.
    expect(screen.getByTestId('value').textContent).toBe('none');
  });

  it('preview mode mounts the live provider without throwing', async () => {
    render(
      <StableModeProvider mode="preview">
        <Probe tagId="EDGE-01/water_temp" />
      </StableModeProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('connected')).toBeTruthy());
  });
});
