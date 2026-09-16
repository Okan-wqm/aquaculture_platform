/**
 * T8 trend honesty: TrendChartRenderer must NOT fabricate demo traces at
 * runtime. Demo data exists ONLY in edit mode (labeled "demo"); an empty
 * buffer at runtime renders the explicit "No trend data available" state,
 * and the placeholder tags ['Tag1','Tag2'] are never queried.
 */

import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import TrendChartRenderer from '../../scada-builder/widget-renderers/TrendChartRenderer';
import { useScadaPackageStore } from '../../../store/scada/createScadaStore';

describe('T8 TrendChartRenderer: no demo data at runtime', () => {
  beforeEach(() => {
    useScadaPackageStore.getState().reset();
    // simulationMode defaults to false = live/runtime rendering path.
  });

  it('shows the explicit empty state (not fake sine waves) when runtime has no data', () => {
    render(
      <TrendChartRenderer
        config={{ label: 'pH Trend', tags: ['ph_sensor'] }}
        width={400}
        height={240}
        isEditing={false}
      />,
    );

    expect(screen.getByText('No trend data available')).toBeTruthy();
    // No "demo" marker outside edit mode.
    expect(screen.queryByText('demo')).toBeNull();
    // No polylines fabricated from demo traces.
    expect(document.querySelectorAll('polyline').length).toBe(0);
  });

  it('shows labeled demo data in edit mode only', () => {
    render(
      <TrendChartRenderer
        config={{ label: 'pH Trend', tags: ['ph_sensor'] }}
        width={400}
        height={240}
        isEditing={true}
      />,
    );

    // Edit mode: demo marker visible and placeholder traces drawn.
    expect(screen.getByText('demo')).toBeTruthy();
    expect(document.querySelectorAll('polyline').length).toBeGreaterThan(0);
  });

  it('renders an explicit empty state (no demo) even with no tag bindings at runtime', () => {
    render(
      <TrendChartRenderer
        config={{ label: 'Untitled' }}
        width={400}
        height={240}
        isEditing={false}
      />,
    );

    expect(screen.getByText('No trend data available')).toBeTruthy();
    expect(document.querySelectorAll('polyline').length).toBe(0);
  });
});
