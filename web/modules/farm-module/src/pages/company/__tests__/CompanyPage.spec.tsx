/**
 * CompanyPage specs (FARM-MEDIUM-120).
 *
 * The company form must hydrate from the backend regulatory-settings record,
 * not from placeholder text — a broken read path fails here.
 */
import { screen } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

vi.mock('@aquaculture/shared-ui', async () =>
  (await import('../../../test-utils/sharedUiMock')).createSharedUiMock(),
);

import { requestMock } from '../../../test-utils/sharedUiMock';
import { routeGraphql } from '../../../test-utils/mockGraphqlClient';
import { renderWithProviders } from '../../../test-utils/renderWithProviders';
import CompanyPage from '../CompanyPage';

const SETTINGS = {
  id: 'reg-1',
  companyName: 'Nordic Salmon AS',
  organisationNumber: '998877665',
  companyAddress: { street: 'Storgata 1', postalCode: '5003', city: 'Bergen', country: 'Norway' },
  updatedAt: '2026-06-01T00:00:00.000Z',
};

beforeEach(() => {
  requestMock.mockReset();
  routeGraphql([
    { match: 'query GetRegulatorySettings', result: { regulatorySettings: SETTINGS } },
  ]);
});

describe('CompanyPage', () => {
  it('hydrates the company form from the backend regulatory settings', async () => {
    renderWithProviders(<CompanyPage />);

    expect(await screen.findByText('Company Information')).toBeInTheDocument();
    // The org name + number are read from the backend record, not placeholders.
    expect(await screen.findByDisplayValue('Nordic Salmon AS')).toBeInTheDocument();
    expect(screen.getByDisplayValue('998877665')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Bergen')).toBeInTheDocument();
    expect(
      requestMock.mock.calls.some(([q]) => (q as string).includes('query GetRegulatorySettings')),
    ).toBe(true);
  });
});
