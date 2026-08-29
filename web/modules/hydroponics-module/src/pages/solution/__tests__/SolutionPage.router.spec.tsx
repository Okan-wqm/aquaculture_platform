import React, { type ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../context/SolutionContext', () => ({
  SolutionProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useSolution: () => ({ mode: { nsType: 'standard' } }),
}));

vi.mock('../tabs/GeneralOptionsTab', () => ({ default: () => <div>General tab content</div> }));
vi.mock('../tabs/WaterAnalysisTab', () => ({ default: () => <div>Water tab content</div> }));
vi.mock('../tabs/UserOptionsTab', () => ({ default: () => <div>User tab content</div> }));
vi.mock('../tabs/ResultTab', () => ({ default: () => <div>Result tab content</div> }));
vi.mock('../tabs/DrainageCompositionTab', () => ({ default: () => null }));
vi.mock('../tabs/PreviousDrainageTab', () => ({ default: () => null }));
vi.mock('../tabs/CurrentNsFormulaTab', () => ({ default: () => null }));
vi.mock('../tabs/ReadjustmentSettingsTab', () => ({ default: () => null }));

import SolutionPage from '../SolutionPage';

const LocationProbe = (): React.ReactElement => {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
};

describe('SolutionPage nested solution/* routing', () => {
  it('settles the index redirect and tab transition under async router updates', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/hydroponics/solution']}>
        <Routes>
          <Route
            path="/hydroponics/solution/*"
            element={
              <>
                <SolutionPage />
                <LocationProbe />
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText('General tab content')).toBeTruthy();
    expect((await screen.findByTestId('location')).textContent).toBe(
      '/hydroponics/solution/general_options',
    );

    await user.click(screen.getByRole('tab', { name: 'Water Analysis' }));

    expect(await screen.findByText('Water tab content')).toBeTruthy();
    expect((await screen.findByTestId('location')).textContent).toBe(
      '/hydroponics/solution/water_analysis',
    );
  });
});
