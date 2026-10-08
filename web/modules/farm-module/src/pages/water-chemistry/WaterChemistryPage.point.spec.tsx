/**
 * The calculator at a measurement point runs the shared composition: a tank
 * reads its TOXICITY set and its loop's alkalinity, calcium and volume — no
 * default reaches the engine, the measured fields are read-only in the input
 * bar, a flagged value stops the calculation, and a tank offers no dose.
 */
import { fireEvent, screen } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

vi.mock('@aquaculture/shared-ui', async () =>
  (await import('../../test-utils/sharedUiMock')).createSharedUiMock(),
);
vi.mock('./components/sources/PointPicker', () => ({
  PointPicker: (props: { onChange: (point: { kind: 'tank'; id: string }) => void }) => (
    <button type="button" onClick={() => props.onChange({ kind: 'tank', id: TANK })}>
      pick tank
    </button>
  ),
}));
vi.mock('@platform/shared-ui/water-chemistry/components', () => ({
  DeffeyesChart: () => <div data-testid="deffeyes-chart" />,
  ResultsPanel: (props: { dosingUnavailable?: string }) => (
    <div data-testid="results-panel">{props.dosingUnavailable ?? 'recipes'}</div>
  ),
  UiaVsPhChart: () => <div />,
  H2sVsPhChart: () => <div />,
  CarbonateVsPhChart: () => <div />,
  CalciteSaturationChart: () => <div />,
}));
vi.mock('./components/RecordTab', () => ({ RecordTab: () => null }));
vi.mock('./components/BulkRecordTab', () => ({ BulkRecordTab: () => null }));
vi.mock('./components/HistoryTab', () => ({ HistoryTab: () => null }));
vi.mock('./components/ParameterConfigManager', () => ({ ParameterConfigManager: () => null }));

import { routeGraphql } from '../../test-utils/mockGraphqlClient';
import { renderWithProviders } from '../../test-utils/renderWithProviders';
import WaterChemistryPage from './WaterChemistryPage';

const TANK = '1b4e28ba-2fa1-41d2-883f-0016d3cca427';
const SYSTEM = '0f8fad5b-d9cb-469f-a165-70867728950e';

function input(
  engineInput: string,
  value: number,
  problems: string[] = [],
): Record<string, unknown> {
  return {
    engineInput,
    quantity: engineInput,
    unit: 'x',
    coherenceWindow: 'SHORT',
    windowSeconds: 14_400,
    parameterConfigId: `p-${engineInput}`,
    problems,
    reading: {
      parameterConfigId: `p-${engineInput}`,
      value,
      unit: 'x',
      sourceKind: 'CHANNEL_PRIMARY',
      inheritedFrom: null,
      sensorId: 'sensor-1',
      channelKey: engineInput,
      observedAt: new Date().toISOString(),
      ageSeconds: 0,
      quality: 'GOOD',
      unresolved: null,
      resolvedAt: null,
      skipped: [],
    },
  };
}

function routes(h2sProblems: string[]): void {
  routeGraphql([
    {
      match: 'query WaterChemistryInputs',
      result: (variables) =>
        variables !== undefined && variables.set === 'TOXICITY'
          ? {
              waterChemistryInputs: {
                set: 'TOXICITY',
                point: { kind: 'TANK', id: TANK },
                asOf: new Date().toISOString(),
                verdict: h2sProblems.length > 0 ? 'INCOMPLETE' : 'READY',
                problems: h2sProblems.length > 0 ? ['INPUTS_INCOMPLETE'] : [],
                systemType: null,
                volumeM3: null,
                tankWaterM3: null,
                loopSystemIds: [SYSTEM],
                inputs: [
                  input('pH', 7.1),
                  input('tempC', 12),
                  input('salinity', 30),
                  input('tan', 0.5),
                  input('h2sUgL', 3.5, h2sProblems),
                ],
              },
            }
          : {
              waterChemistryInputs: {
                set: 'DOSING',
                point: { kind: 'SYSTEM', id: SYSTEM },
                asOf: new Date().toISOString(),
                verdict: 'READY',
                problems: [],
                systemType: 'RAS',
                volumeM3: 120,
                tankWaterM3: 40,
                loopSystemIds: [],
                inputs: [
                  input('pH', 7.3),
                  input('alkalinityMg', 110),
                  input('tempC', 12),
                  input('salinity', 30),
                  input('caMgL', 390),
                ],
              },
            },
    },
  ]);
}

async function pickTank(): Promise<void> {
  renderWithProviders(<WaterChemistryPage />, {
    route: '/water-chemistry',
    path: 'water-chemistry',
  });
  fireEvent.click(screen.getByRole('button', { name: 'A measurement point' }));
  fireEvent.click(screen.getByRole('button', { name: 'pick tank' }));
  await screen.findByTestId('values-source-bar');
}

describe('WaterChemistryPage at a measurement point', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calculates from the tank and its loop's carbonate state, with no default and no dose", async () => {
    routes([]);
    await pickTank();

    expect(await screen.findByTestId('deffeyes-chart')).toBeInTheDocument();
    // The loop's alkalinity, read-only — never the calculator's opening 80.
    fireEvent.click(screen.getByRole('button', { name: 'Realtime' }));
    const alkalinity = screen.getByLabelText('Alkalinity');
    expect(alkalinity).toHaveValue(110);
    expect(alkalinity).toBeDisabled();
    expect(screen.getByTestId('results-panel')).toHaveTextContent(
      "A dose is computed for the loop: choose the tank's system",
    );
  });

  it('does not calculate from a value the backend flags', async () => {
    routes(['NOT_SAME_SAMPLE']);
    await pickTank();

    expect(await screen.findByText('The calculation does not run: H₂S (µg/L)')).toHaveAttribute(
      'data-testid',
      'engine-not-ready',
    );
    expect(screen.queryByTestId('deffeyes-chart')).toBeNull();
  });
});
