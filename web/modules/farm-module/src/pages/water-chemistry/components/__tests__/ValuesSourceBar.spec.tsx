/**
 * ValuesSourceBar: at a point every field shows what the shared composition
 * decided — a flagged value (the backend keeps it, with NOT_SAME_SAMPLE) is
 * shown struck and not used; a REFUSED loop's volume is not used; an entry is
 * the operator's, for this session.
 */
import {
  composePointInputs,
  type InputSetResult,
  type InputStatusResult,
} from '@aquaculture/shared-ui';
import { fireEvent, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

vi.mock('@aquaculture/shared-ui', async () =>
  (await import('../../../../test-utils/sharedUiMock')).createSharedUiMock(),
);
vi.mock('../sources/PointPicker', () => ({ PointPicker: () => null }));

import { renderWithProviders } from '../../../../test-utils/renderWithProviders';
import { ValuesSourceBar } from '../ValuesSourceBar';

const TANK = '1b4e28ba-2fa1-41d2-883f-0016d3cca427';
const NOW = Date.parse('2026-10-08T10:00:00.000Z');

function input(
  engineInput: string,
  value: number | null,
  problems: InputStatusResult['problems'] = [],
): InputStatusResult {
  return {
    engineInput,
    quantity: engineInput,
    unit: 'x',
    coherenceWindow: 'SHORT',
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
            sourceKind: 'CHANNEL_PRIMARY',
            inheritedFrom: null,
            sensorId: 'sensor-1',
            channelKey: engineInput,
            observedAt: '2026-10-08T09:40:00.000Z',
            ageSeconds: 1200,
            quality: 'GOOD',
            unresolved: null,
            resolvedAt: null,
            skipped: [],
          },
  };
}

// The backend's shape: H2S keeps its value and carries NOT_SAME_SAMPLE.
const TOXICITY: InputSetResult = {
  set: 'TOXICITY',
  point: { kind: 'TANK', id: TANK },
  asOf: '2026-10-08T09:59:30.000Z',
  verdict: 'INCOMPLETE',
  problems: ['INPUTS_INCOMPLETE'],
  systemType: null,
  volumeM3: null,
  tankWaterM3: null,
  loopSystemIds: ['system-1'],
  inputs: [
    input('pH', 7.1),
    input('tempC', 12),
    input('salinity', 30),
    input('tan', 0.5),
    input('h2sUgL', 3.5, ['NOT_SAME_SAMPLE']),
  ],
};

// A loop that is not recirculating: REFUSED, yet the volume is carried.
const LOOP: InputSetResult = {
  set: 'DOSING',
  point: { kind: 'SYSTEM', id: 'system-1' },
  asOf: '2026-10-08T09:59:00.000Z',
  verdict: 'REFUSED',
  problems: ['SYSTEM_NOT_RECIRCULATING'],
  systemType: 'FLOW_THROUGH',
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
};

function renderBar(onEnter = vi.fn()): ReturnType<typeof vi.fn> {
  renderWithProviders(
    <ValuesSourceBar
      point={{ kind: 'tank', id: TANK }}
      onPointChange={vi.fn()}
      ownSet={TOXICITY}
      composed={composePointInputs({ own: TOXICITY, loop: LOOP }, {})}
      loading={false}
      loadError={null}
      stale={[]}
      now={NOW}
      onEnter={onEnter}
    />,
  );
  return onEnter;
}

describe('ValuesSourceBar', () => {
  it('shows a flagged value struck and not usable, with the problem that blocks it', () => {
    renderBar();
    const h2s = document.querySelector('[data-field="h2sUgL"]');
    expect(h2s).toHaveAttribute('data-state', 'blocked');
    expect(h2s).toHaveTextContent('3.5');
    expect(h2s).toHaveTextContent('Not read within 15 minutes of the pH it is converted with');
    expect(screen.getByText('Toxicity inputs: Incomplete · Resolved just now')).toBeInTheDocument();
  });

  it("reads the loop's alkalinity, and never a REFUSED loop's volume", () => {
    renderBar();
    const alkalinity = document.querySelector('[data-field="alkalinityMg"]');
    expect(alkalinity).toHaveAttribute('data-state', 'measured');
    expect(alkalinity).toHaveTextContent('from the loop');
    const volume = document.querySelector('[data-field="volume"]');
    expect(volume).toHaveAttribute('data-state', 'blocked');
    expect(volume).toHaveTextContent('The system is not a recirculating loop');
  });

  it("reports the operator's session correction", () => {
    const onEnter = renderBar();
    fireEvent.change(screen.getByLabelText('Correct H₂S (µg/L) for this session'), {
      target: { value: '2.5' },
    });
    expect(onEnter).toHaveBeenCalledWith('h2sUgL', 2.5);
  });
});
