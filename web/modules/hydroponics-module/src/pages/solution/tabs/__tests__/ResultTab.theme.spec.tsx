/**
 * ResultTab — Industry console fit.
 *
 * The tank badges were round, and tank B painted from the `accent-*` scale —
 * the design system's High alarm tier, amber in the console, on a category
 * that is no alarm (README §7.8). Save Configuration — the tab's primary
 * action — filled from the success scale, which the scope turns graphite. In
 * Industry a badge is square (README §7.8), the workspace accent is the one
 * brand colour and the primary action carries it.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { emptyVector, type CalcResult } from '../../../../lib/calculator/types';
import { createDefaultSettings } from '../../../../types/solution.types';

const result: CalcResult = {
  dripSolution: emptyVector(),
  irrigationWater: emptyVector(),
  addedSolution: emptyVector(),
  toAdd: emptyVector(),
  fertilizers: [
    { name: 'Calcium nitrate', formula: 'Ca(NO3)2', tank: 'A', mmolPerLiter: 1, gramsPerLiter: 2 },
    { name: 'Potassium sulfate', formula: 'K2SO4', tank: 'B', mmolPerLiter: 1, gramsPerLiter: 3 },
  ],
  ionBalance: { totalCations: 10, totalAnions: 10, balancePercent: 0 },
  warnings: [],
  ec: 1.8,
  ph: 5.8,
};

vi.mock('../../../../context/SolutionContext', () => ({
  useSolution: () => ({
    settings: createDefaultSettings(),
    isDirty: true,
    save: vi.fn(),
    mode: { systemType: 'open' },
  }),
}));
vi.mock('../../../../hooks/useLookupValues', () => ({
  useLookupValues: () => ({ profile: {} }),
}));
vi.mock('../../../../hooks/useCalculation', () => ({
  useCalculation: () => result,
}));

import ResultTab from '../ResultTab';

describe('ResultTab — Industry fit', () => {
  it('draws the tank badges square, tank B in the workspace accent', () => {
    render(<ResultTab />);

    const badgeA = screen.getByText('A', { selector: 'span' });
    const badgeB = screen.getByText('B', { selector: 'span' });
    for (const badge of [badgeA, badgeB]) {
      expect(badge).not.toHaveClass('rounded-full');
      expect(badge.className).not.toMatch(/\baccent-\d/);
    }
    expect(badgeB).toHaveClass('bg-primary-100', 'text-primary-700');
  });

  it('fills the dirty Save Configuration action with the workspace accent', () => {
    render(<ResultTab />);

    const save = screen.getByRole('button', { name: 'Save Configuration' });
    expect(save).toHaveClass('bg-primary-600');
    expect(save.className).not.toMatch(/\bbg-success-\d/);
  });
});
