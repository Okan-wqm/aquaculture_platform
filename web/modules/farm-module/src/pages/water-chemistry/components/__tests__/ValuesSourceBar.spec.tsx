/**
 * ValuesSourceBar: for a point, each value the calculation reads there shows
 * where it came from, its window and why it is missing; a correction is the
 * operator's, for this session.
 */
import { fireEvent, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

vi.mock('@aquaculture/shared-ui', async () =>
  (await import('../../../../test-utils/sharedUiMock')).createSharedUiMock(),
);
vi.mock('../sources/PointPicker', () => ({ PointPicker: () => null }));

import {
  applyResolved,
  DEFAULT_WATER_CHEMISTRY_INPUTS,
  type InputSetResult,
} from '@aquaculture/shared-ui';

import { renderWithProviders } from '../../../../test-utils/renderWithProviders';
import { ValuesSourceBar } from '../ValuesSourceBar';

const TANK = '1b4e28ba-2fa1-41d2-883f-0016d3cca427';

function input(
  engineInput: string,
  value: number | null,
  problems: InputSetResult['inputs'][number]['problems'] = [],
): InputSetResult['inputs'][number] {
  return {
    engineInput,
    quantity: engineInput,
    unit: 'x',
    coherenceWindow: engineInput === 'h2sUgL' ? 'SHORT' : 'LONG',
    windowSeconds: 14_400,
    parameterConfigId: `p-${engineInput}`,
    problems,
    reading:
      value === null
        ? null
        : {
            parameterConfigId: `p-${engineInput}`,
            value,
            unit: 'x',
            sourceKind: 'MANUAL',
            inheritedFrom: null,
            sensorId: null,
            channelKey: null,
            observedAt: '2026-10-08T09:00:00.000Z',
            ageSeconds: 3600,
            quality: null,
            unresolved: null,
            resolvedAt: null,
            skipped: [],
          },
  };
}

const SET: InputSetResult = {
  set: 'TOXICITY',
  point: { kind: 'TANK', id: TANK },
  asOf: '2026-10-08T10:00:00.000Z',
  verdict: 'INCOMPLETE',
  problems: ['INPUTS_INCOMPLETE'],
  systemType: null,
  volumeM3: null,
  tankWaterM3: null,
  inputs: [
    input('pH', 7.1),
    input('tempC', 12),
    input('salinity', 30),
    input('tan', 0.5),
    input('h2sUgL', null, ['NOT_SAME_SAMPLE']),
  ],
};

describe('ValuesSourceBar', () => {
  it('shows each covered value, its window, and why one is missing; a correction is reported', () => {
    const onOverride = vi.fn();
    const applied = applyResolved({ ...DEFAULT_WATER_CHEMISTRY_INPUTS }, [SET], {
      overrides: {},
      uncovered: 'base',
    });
    expect(applied.inputs).toBeNull();

    renderWithProviders(
      <ValuesSourceBar
        point={{ kind: 'tank', id: TANK }}
        onPointChange={vi.fn()}
        inputSet={SET}
        applied={applied}
        loadError={null}
        now={Date.parse('2026-10-08T10:00:00.000Z')}
        onOverride={onOverride}
      />,
    );

    expect(screen.getByText('Incomplete')).toBeInTheDocument();
    const h2s = document.querySelector('[data-field="h2sUgL"]');
    expect(h2s).toHaveAttribute('data-origin', 'missing');
    expect(h2s).toHaveTextContent('Not read within 15 minutes of the pH it is converted with');
    expect(h2s).toHaveTextContent('read within 4 h');
    // Alkalinity is not a TOXICITY input: the entry stands and no chip is shown.
    expect(document.querySelector('[data-field="alkalinityMg"]')).toBeNull();

    fireEvent.change(screen.getByLabelText('Correct H₂S (µg/L) for this session'), {
      target: { value: '2.5' },
    });
    expect(onOverride).toHaveBeenCalledWith('h2sUgL', 2.5);
  });
});
