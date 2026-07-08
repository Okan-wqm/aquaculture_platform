/**
 * BiomassAltinnPanel (RPT-001, Phase 5) — exercises the REAL biomass Altinn
 * state-machine hooks (mark ready / reopen / confirm) + the FD-0001 export
 * query against a mocked graphqlClient transport, following the module's
 * federation-free vitest convention.
 *
 * It also pins the honesty of the copy: the panel must describe the MANUAL
 * Altinn channel and never claim an electronic Fiskeridirektoratet submission.
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
import { BiomassAltinnPanel } from '../BiomassAltinnPanel';
import type {
  BiomassReportListRow,
  BiomassReportStatusValue,
} from '../../../../hooks/useBiomassReports';
import '@testing-library/jest-dom/vitest';

const EXPORT = {
  filename: 'FD-0001-ssssssss-2026-04.csv',
  periodLabel: '2026-04',
  csv: 'Section,Field,Value\nReport,Period,2026-4',
  printable: 'Fiskeridirektoratet FD-0001 — Monthly biomass report\nPeriod: 2026-04',
  generatedAt: '2026-07-06T00:00:00.000Z',
};

function row(status: BiomassReportStatusValue): BiomassReportListRow {
  return {
    id: 'report-1',
    reportMonth: 4,
    reportYear: 2026,
    status,
    totalBiomassKg: '42000.00',
    readyAt: status === 'DRAFT' ? null : '2026-07-05T00:00:00.000Z',
    altinnReference: status === 'CONFIRMED_SUBMITTED' ? 'AR-42' : null,
    submittedAt: null,
    updatedAt: '2026-07-05T00:00:00.000Z',
  };
}

function routeGraphql(): void {
  requestMock.mockImplementation((query: string) => {
    if (query.includes('biomassReportAltinnExport')) {
      return Promise.resolve({ biomassReportAltinnExport: EXPORT });
    }
    if (query.includes('markBiomassReportReady')) {
      return Promise.resolve({ markBiomassReportReady: { ...row('READY') } });
    }
    if (query.includes('revertBiomassReportToDraft')) {
      return Promise.resolve({ revertBiomassReportToDraft: { ...row('DRAFT') } });
    }
    if (query.includes('confirmBiomassReportSubmitted')) {
      return Promise.resolve({ confirmBiomassReportSubmitted: { ...row('CONFIRMED_SUBMITTED') } });
    }
    return Promise.resolve({});
  });
}

function renderPanel(status: BiomassReportStatusValue): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <BiomassAltinnPanel report={row(status)} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  requestMock.mockReset();
});

describe('BiomassAltinnPanel', () => {
  it('DRAFT: describes the MANUAL Altinn channel — no false electronic-submission claim', () => {
    routeGraphql();
    renderPanel('DRAFT');

    expect(screen.getByText(/submitted to Fiskeridirektoratet manually via Altinn/i)).toBeInTheDocument();
    // The old dishonest copy must be gone.
    expect(
      screen.queryByText(/This report will be submitted to Fiskeridirektoratet\./i),
    ).not.toBeInTheDocument();
  });

  it('DRAFT: mark ready calls the markReady mutation with the report id', async () => {
    routeGraphql();
    renderPanel('DRAFT');

    await userEvent.click(screen.getByRole('button', { name: /Mark ready for Altinn/i }));

    await waitFor(() => {
      const call = requestMock.mock.calls.find((c) =>
        String(c[0]).includes('markBiomassReportReady'),
      );
      expect(call?.[1]).toEqual({ id: 'report-1' });
    });
  });

  it('READY: renders the FD-0001 export and gates confirm on a non-empty reference', async () => {
    routeGraphql();
    renderPanel('READY');

    // The export loads and its filename + printable block render.
    await waitFor(() =>
      expect(screen.getByText(/Download CSV \(FD-0001-ssssssss-2026-04\.csv\)/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/Fiskeridirektoratet FD-0001 — Monthly biomass report/i)).toBeInTheDocument();

    // Confirm is disabled until a reference is entered.
    const confirmBtn = screen.getByRole('button', { name: /Confirm submitted/i });
    expect(confirmBtn).toBeDisabled();

    await userEvent.type(screen.getByLabelText(/Altinn receipt reference/i), '  AR-42  ');
    expect(confirmBtn).toBeEnabled();

    await userEvent.click(confirmBtn);

    await waitFor(() => {
      const call = requestMock.mock.calls.find((c) =>
        String(c[0]).includes('confirmBiomassReportSubmitted'),
      );
      // The reference is trimmed before it crosses the wire.
      expect(call?.[1]).toEqual({ id: 'report-1', altinnReference: 'AR-42' });
    });
  });

  it('READY: reopen calls the revertToDraft mutation', async () => {
    routeGraphql();
    renderPanel('READY');

    await userEvent.click(screen.getByRole('button', { name: /Reopen to draft/i }));

    await waitFor(() => {
      const call = requestMock.mock.calls.find((c) =>
        String(c[0]).includes('revertBiomassReportToDraft'),
      );
      expect(call?.[1]).toEqual({ id: 'report-1' });
    });
  });

  it('CONFIRMED_SUBMITTED: shows the Altinn receipt and offers no lifecycle actions', () => {
    routeGraphql();
    renderPanel('CONFIRMED_SUBMITTED');

    expect(screen.getByText(/Submitted to Fiskeridirektoratet via Altinn/i)).toBeInTheDocument();
    expect(screen.getByText('AR-42')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
