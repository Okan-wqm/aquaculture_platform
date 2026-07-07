/**
 * 6e — builder ⇄ operator single-plane parity.
 *
 * The Faz-6 goal is "a value set on a widget in the builder appears under the
 * SAME binding key in the operator view" — proof that the two runtimes share
 * ONE binding accessor (`getWidgetTagBinding`) and ONE live-data plane
 * (`DataProviderRoot` + `useRealtimeData`), closing the historical split where
 * the builder read `config.tagName` and the operator read `config.tagId` (so
 * the same widget bound different tags in the two runtimes).
 *
 * The repo has no browser UI e2e harness (its Playwright project is HTTP/
 * security only; module e2e is GraphQL/Jest), so a literal cross-page browser
 * smoke would be a non-running test. This pins the exact invariant that smoke
 * would assert, deterministically, at the layer the property actually lives:
 * the shared accessor + the shared provider chain both canvases mount.
 */

import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, beforeEach } from 'vitest';

import { useScadaPackageStore } from '../../../store/scada';
import { useRealtimeData } from '../../../hooks/useRealtimeData';
import { DataProviderRoot } from '../../../providers/DataProviderContext';
import { getWidgetTagBinding } from '../index';

/**
 * A widget that resolves its live value EXACTLY the way both ScreenCanvas
 * (builder/preview) and OperatorView do: `getWidgetTagBinding(config)` →
 * `useRealtimeData(key)` → `values[key]`. The two runtimes differ only in the
 * config they were historically authored with; the resolution is identical.
 */
function Widget({
  config,
  testid,
}: {
  config: Record<string, unknown>;
  testid: string;
}): React.ReactElement {
  const key = getWidgetTagBinding(config);
  const { values } = useRealtimeData(key ? [key] : []);
  const value = key ? values[key]?.value : undefined;
  return <span data-testid={testid}>{String(value ?? 'none')}</span>;
}

describe('6e — builder ⇄ operator single-plane parity', () => {
  beforeEach(() => {
    useScadaPackageStore.setState({ simTagValues: {} });
  });

  it('the canonical tagRef and both legacy bindings resolve to ONE key', () => {
    // Canonical V2 (`tagRef`), legacy builder (`tagName`) and legacy operator
    // (`tagId`) all collapse to the same device-local key.
    expect(getWidgetTagBinding({ tagRef: 'EDGE-01/water_temp' })).toBe('water_temp');
    expect(getWidgetTagBinding({ tagName: 'water_temp' })).toBe('water_temp');
    expect(getWidgetTagBinding({ tagId: 'water_temp' })).toBe('water_temp');
  });

  it('a value on the shared plane is seen identically by a builder- and an operator-authored widget', async () => {
    // One value pushed onto the single simulation plane under the operator's key.
    useScadaPackageStore.setState({ simTagValues: { water_temp: 21.5 } });

    render(
      <DataProviderRoot type="simulation">
        {/* builder-authored widget (canonical tagRef) */}
        <Widget config={{ tagRef: 'EDGE-01/water_temp' }} testid="builder" />
        {/* operator-authored widget (legacy tagId) — same underlying tag */}
        <Widget config={{ tagId: 'water_temp' }} testid="operator" />
      </DataProviderRoot>,
    );

    // Both widgets converge on the SAME value from the SAME plane — the split
    // (builder reads tagName, operator reads tagId) can no longer diverge.
    await waitFor(() => expect(screen.getByTestId('builder').textContent).toBe('21.5'));
    expect(screen.getByTestId('operator').textContent).toBe('21.5');
  });
});
