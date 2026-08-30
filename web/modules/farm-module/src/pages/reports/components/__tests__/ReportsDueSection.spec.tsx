/**
 * ReportsDueSection (RPT-003) — exercises the REAL useReportDeadlines +
 * lifecycle mutation hooks against a mocked graphqlClient transport, following
 * the module's federation-free vitest convention.
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
import { ReportsDueSection } from '../ReportsDueSection';
import '@testing-library/jest-dom/vitest';

const DEADLINES = [
  {
    id: 'draft-ready',
    reportType: 'SEA_LICE',
    siteId: 'site-1',
    periodYear: 2026,
    periodWeek: 27,
    periodMonth: null,
    status: 'READY',
    dueAt: '2026-07-07',
    overdue: false,
    daysUntilDue: 1,
  },
  {
    id: 'draft-blocked',
    reportType: 'SMOLT',
    siteId: 'site-1',
    periodYear: 2026,
    periodWeek: null,
    periodMonth: 6,
    status: 'DRAFT',
    dueAt: '2026-07-04',
    overdue: true,
    daysUntilDue: -2,
  },
];

const DRAFTS = [
  {
    id: 'draft-ready',
    reportType: 'SEA_LICE',
    siteId: 'site-1',
    periodYear: 2026,
    periodWeek: 27,
    periodMonth: null,
    status: 'READY',
    schemaValid: true,
    dueAt: '2026-07-07',
    assembledPayload: { sjøtemperatur: 12.4, godkjenningsnummer: null },
    fieldMeta: [
      { path: '/sjøtemperatur', provenance: 'SENSOR', blocking: false },
      {
        path: '/godkjenningsnummer',
        provenance: 'MANUAL_REQUIRED',
        blocking: true,
        message: 'Enter it',
      },
    ],
    manualOverrides: null,
  },
];

function routeGraphql(overrides?: { approve?: unknown }): void {
  requestMock.mockImplementation((query: string) => {
    if (query.includes('reportDeadlines')) return Promise.resolve({ reportDeadlines: DEADLINES });
    if (query.includes('reportDrafts')) return Promise.resolve({ reportDrafts: DRAFTS });
    if (query.includes('saveReportDraftOverrides')) {
      return Promise.resolve({
        saveReportDraftOverrides: {
          id: 'draft-ready',
          status: 'READY',
          schemaValid: true,
          manualOverrides: { '/godkjenningsnummer': 'A12345' },
        },
      });
    }
    if (query.includes('approveAndSubmitReportDraft')) {
      return Promise.resolve({
        approveAndSubmitReportDraft: overrides?.approve ?? {
          success: true,
          reportId: 'rr-1',
          referanse: 'MT-9',
          feilmelding: null,
          valideringsfeil: null,
        },
      });
    }
    if (query.includes('dismissReportDraft')) {
      return Promise.resolve({ dismissReportDraft: { id: 'draft-ready', status: 'DISMISSED' } });
    }
    if (query.includes('refreshReportDraft')) {
      return Promise.resolve({
        refreshReportDraft: {
          id: 'draft-ready',
          status: 'READY',
          schemaValid: true,
          dueAt: '2026-07-07',
        },
      });
    }
    return Promise.resolve({});
  });
}

function renderSection(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ReportsDueSection />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  requestMock.mockReset();
});

describe('ReportsDueSection', () => {
  it('lists scheduled drafts with their period and deadline chip', async () => {
    routeGraphql();
    renderSection();

    await waitFor(() => expect(screen.getByText('Sea Lice')).toBeInTheDocument());
    expect(screen.getByText('2026 · Week 27')).toBeInTheDocument();
    expect(screen.getByText('Smolt')).toBeInTheDocument();
    expect(screen.getByText('2026 · Month 6')).toBeInTheDocument();
    // Server-driven overdue chip on the blocked draft.
    expect(screen.getByText('2 days overdue')).toBeInTheDocument();
  });

  it('offers Approve & Submit only for a READY draft', async () => {
    routeGraphql();
    renderSection();

    await waitFor(() => expect(screen.getByText('Sea Lice')).toBeInTheDocument());
    // Exactly one Approve button (the READY sea-lice draft), not the DRAFT smolt.
    expect(screen.getAllByRole('button', { name: /Approve & Submit/i })).toHaveLength(1);
  });

  it('shows the Mattilsynet receipt after a successful approve & submit', async () => {
    routeGraphql();
    renderSection();
    await waitFor(() => expect(screen.getByText('Sea Lice')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /Approve & Submit/i }));

    await waitFor(() =>
      expect(screen.getByText(/Submitted — Mattilsynet ref MT-9/i)).toBeInTheDocument(),
    );
  });

  it('surfaces valideringsfeil when the submission is rejected', async () => {
    routeGraphql({
      approve: {
        success: false,
        feilmelding: null,
        valideringsfeil: [{ felt: 'lusetelling', melding: 'påkrevd' }],
      },
    });
    renderSection();
    await waitFor(() => expect(screen.getByText('Sea Lice')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /Approve & Submit/i }));

    await waitFor(() => expect(screen.getByText(/lusetelling: påkrevd/i)).toBeInTheDocument());
  });

  it('reviews a draft: RECORDS/SENSOR read-only, MANUAL editable, and saves overrides', async () => {
    routeGraphql();
    renderSection();
    await waitFor(() => expect(screen.getByText('Sea Lice')).toBeInTheDocument());

    // First row is the READY sea-lice draft (draft-ready).
    await userEvent.click(screen.getAllByRole('button', { name: /^Review$/i })[0]);

    // The review panel renders the assembled fields via PrefilledField.
    await waitFor(() => expect(screen.getByText('sjøtemperatur')).toBeInTheDocument());
    // SENSOR value is read-only (no input); the manual field is editable.
    expect(screen.getByText('12.4')).toBeInTheDocument();
    const manualInput = screen.getByRole('textbox', { name: 'godkjenningsnummer' });
    await userEvent.type(manualInput, 'A12345');

    await userEvent.click(screen.getByRole('button', { name: /Save manual values/i }));

    await waitFor(() => expect(screen.getByText('Saved')).toBeInTheDocument());
    const savedCall = requestMock.mock.calls.find((c) =>
      String(c[0]).includes('saveReportDraftOverrides'),
    );
    expect(savedCall?.[1]).toEqual({
      input: { draftId: 'draft-ready', overrides: { '/godkjenningsnummer': 'A12345' } },
    });
  });

  it('renders the empty state when nothing is due', async () => {
    requestMock.mockResolvedValue({ reportDeadlines: [] });
    renderSection();

    await waitFor(() =>
      expect(screen.getByText(/No scheduled reports are due/i)).toBeInTheDocument(),
    );
  });
});
