/**
 * ReportSettingsModal — the automated-submission section (RPT-003). Verifies the
 * per-report-type toggles reflect the saved policy and drive updateAutoSubmitPolicy.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@aquaculture/shared-ui', async () =>
  (await import('../../../../test-utils/sharedUiMock')).createSharedUiMock(),
);

import { requestMock } from '../../../../test-utils/sharedUiMock';
import { ReportSettingsModal } from '../ReportSettingsModal';
import '@testing-library/jest-dom/vitest';

function routeGraphql(): void {
  requestMock.mockImplementation((query: string) => {
    if (query.includes('GetRegulatorySettings')) {
      return Promise.resolve({
        regulatorySettings: {
          id: 's-1',
          maskinportenConfigured: true,
          siteLocalityMappings: [],
          autoSubmitPolicies: [{ reportType: 'SEA_LICE', enabled: true }],
        },
      });
    }
    if (query.includes('GetConfigurationStatus')) {
      return Promise.resolve({
        regulatoryConfigurationStatus: {
          hasMaskinportenCredentials: true,
          hasDefaultContact: true,
          siteMappingsCount: 0,
          hasSlaughterApproval: false,
          isFullyConfigured: false,
        },
      });
    }
    if (query.includes('GetSites')) {
      return Promise.resolve({ sites: { items: [] } });
    }
    if (query.includes('UpdateAutoSubmitPolicy')) {
      return Promise.resolve({ updateAutoSubmitPolicy: [{ reportType: 'SMOLT', enabled: true }] });
    }
    return Promise.resolve({});
  });
}

function renderModal(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ReportSettingsModal open onClose={vi.fn()} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  requestMock.mockReset();
});

describe('ReportSettingsModal — automated submission', () => {
  it('reflects the saved policy: SEA_LICE on, SMOLT off', async () => {
    routeGraphql();
    renderModal();

    await waitFor(() =>
      expect(screen.getByRole('switch', { name: /Auto-submit Sea Lice/i })).toBeInTheDocument(),
    );
    expect(screen.getByRole('switch', { name: /Auto-submit Sea Lice/i })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('switch', { name: /Auto-submit Smolt/i })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  it('toggling a report type calls updateAutoSubmitPolicy with the new state', async () => {
    routeGraphql();
    renderModal();

    const smoltSwitch = await screen.findByRole('switch', { name: /Auto-submit Smolt/i });
    await userEvent.click(smoltSwitch);

    await waitFor(() => {
      const call = requestMock.mock.calls.find((c) =>
        String(c[0]).includes('UpdateAutoSubmitPolicy'),
      );
      expect(call?.[1]).toEqual({ input: { reportType: 'SMOLT', enabled: true } });
    });
  });
});
