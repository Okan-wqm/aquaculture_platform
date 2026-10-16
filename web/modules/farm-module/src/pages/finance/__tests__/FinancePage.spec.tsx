/**
 * FinancePage specs (FARM-MEDIUM-120, FARM-MEDIUM-439, FARM-MEDIUM-440).
 *
 * The overview tab renders the finance summary fetched from the backend
 * (useFinanceSummary → GetFinanceSummary); the spec proves the page is wired
 * to that query and renders its result rather than a placeholder.
 *
 * Budget and Cost centres have no backend yet. Their figures are sample data
 * that may reach the page only through MockPreview, so these specs pin that
 * each tab renders its figures — and the notes describing them — inside the
 * group the preview notice describes, that the notice names the tracked
 * finding, and that the period control (which those tabs do not follow) is
 * offered only on the tabs it filters.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

vi.mock('@aquaculture/shared-ui', async () =>
  (await import('../../../test-utils/sharedUiMock')).createSharedUiMock(),
);

import { I18nProvider } from '@aquaculture/shared-ui';

import { requestMock } from '../../../test-utils/sharedUiMock';
import { routeGraphql } from '../../../test-utils/mockGraphqlClient';
import { renderWithProviders } from '../../../test-utils/renderWithProviders';
import FinancePage from '../FinancePage';

const SUMMARY = {
  currency: 'NOK',
  totalExpenseDecimal: '12500.00',
  totalRevenueDecimal: '40000.00',
  netResultDecimal: '27500.00',
  byCategory: [],
  series: [],
};

beforeEach(() => {
  requestMock.mockReset();
  routeGraphql([{ match: 'query GetFinanceSummary', result: { financeSummary: SUMMARY } }]);
});

/** How many finance-summary reads the page has made. */
function summaryRequests(): number {
  return requestMock.mock.calls.filter(([query]) =>
    String(query).includes('query GetFinanceSummary'),
  ).length;
}

/** The preview notice and the group of figures it describes. */
function previewOf(finding: string): { notice: HTMLElement; figures: HTMLElement } {
  const notice = screen.getByRole('note');
  expect(within(notice).getByText('PREVIEW · NO BACKEND YET')).toBeInTheDocument();
  expect(within(notice).getByText(`Tracked as ${finding}.`)).toBeInTheDocument();
  expect(within(notice).getByText('Data shown is sample data.')).toBeInTheDocument();
  const figures = screen.getByRole('group', { description: /PREVIEW · NO BACKEND YET/ });
  return { notice, figures };
}

describe('FinancePage', () => {
  it('renders the finance overview from the backend summary query', async () => {
    renderWithProviders(<FinancePage />, { route: '/sites/finance' });

    expect(await screen.findByText('Farm Finance')).toBeInTheDocument();

    // The overview tab settles on the backend summary (not the loading state).
    await waitFor(() => {
      expect(
        requestMock.mock.calls.some(([q]) => (q as string).includes('query GetFinanceSummary')),
      ).toBe(true);
    });
    expect(screen.queryByText('Loading finance summary…')).not.toBeInTheDocument();
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });

  it('lists every finance tab, the console’s budget and cost centres included', () => {
    renderWithProviders(<FinancePage />, { route: '/sites/finance' });
    const tabs = screen.getByRole('navigation', { name: 'Finance tabs' });
    expect(
      within(tabs)
        .getAllByRole('button')
        .map((tab) => tab.textContent),
    ).toEqual([
      'Overview',
      'Expenses',
      'Budget',
      'Cost centres',
      'Charts',
      'Categories',
      'Finance settings',
    ]);
    expect(within(tabs).getByRole('button', { name: 'Overview' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('renders ?tab=budget as a labelled preview naming FARM-MEDIUM-439', () => {
    renderWithProviders(<FinancePage />, { route: '/sites/finance?tab=budget' });

    expect(
      within(screen.getByRole('navigation', { name: 'Finance tabs' })).getByRole('button', {
        name: 'Budget',
      }),
    ).toHaveAttribute('aria-current', 'page');
    const { notice, figures } = previewOf('FARM-MEDIUM-439');
    expect(
      within(notice).getByText(/farm-service has no budget per cost centre/),
    ).toBeInTheDocument();

    // Every budget figure sits inside the described group.
    expect(within(figures).getByRole('columnheader', { name: 'Cost centre' })).toBeInTheDocument();
    expect(within(figures).getByText('Aquaculture production')).toBeInTheDocument();
    expect(within(figures).getByText('October 2026 · 1–14 (day 14 of 31)')).toBeInTheDocument();
    // The greenhouse centre runs 30 % over: its forecast is flagged in words.
    const greenhouse = within(figures).getByText('Greenhouse').closest('tr');
    if (greenhouse === null) throw new Error('greenhouse row not rendered');
    expect(within(greenhouse).getByText('704')).toBeInTheDocument();
    expect(within(greenhouse).getByText('More than 10 % over')).toBeInTheDocument();
  });

  it('renders ?tab=cost-centres as a labelled preview naming FARM-MEDIUM-440', () => {
    renderWithProviders(<FinancePage />, { route: '/sites/finance?tab=cost-centres' });

    const { notice, figures } = previewOf('FARM-MEDIUM-440');
    expect(
      within(notice).getByText(/no cost centre bound to the location tree/),
    ).toBeInTheDocument();
    expect(within(figures).getByRole('heading', { name: 'Cost centres' })).toBeInTheDocument();
    expect(within(figures).getByText('HAT')).toBeInTheDocument();
    expect(
      within(figures).getByRole('heading', { name: 'Unit production cost · October 1–14' }),
    ).toBeInTheDocument();
    expect(within(figures).getByText('64.5')).toBeInTheDocument();
    // The notes describe the sample's model, so they are part of the sample.
    expect(
      within(figures).getByText('Every expense is tagged with one cost centre and one site.'),
    ).toBeInTheDocument();
    expect(
      within(figures).getByText(
        'Output = biomass gain or harvest in the period. HR and administration costs are not allocated to unit cost.',
      ),
    ).toBeInTheDocument();
  });

  it('offers the period only on the tabs it filters, and fetches no summary for the previews', async () => {
    const { unmount } = renderWithProviders(<FinancePage />, { route: '/sites/finance' });
    expect(screen.getByLabelText('Period:')).toBeInTheDocument();
    await waitFor(() => expect(summaryRequests()).toBe(1));
    unmount();
    requestMock.mockClear();

    for (const tab of ['budget', 'cost-centres']) {
      const view = renderWithProviders(<FinancePage />, { route: `/sites/finance?tab=${tab}` });
      previewOf(tab === 'budget' ? 'FARM-MEDIUM-439' : 'FARM-MEDIUM-440');
      expect(screen.queryByText('Period:')).not.toBeInTheDocument();
      expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
      view.unmount();
    }
    expect(summaryRequests()).toBe(0);
  });

  it('heads the Turkish amount columns with the currency symbol, as the design does', () => {
    const budget = renderWithProviders(
      <I18nProvider locale="tr">
        <FinancePage />
      </I18nProvider>,
      { route: '/sites/finance?tab=budget' },
    );
    expect(screen.getByRole('columnheader', { name: 'Aylık bütçe · bin ₺' })).toBeInTheDocument();
    budget.unmount();

    renderWithProviders(
      <I18nProvider locale="tr">
        <FinancePage />
      </I18nProvider>,
      { route: '/sites/finance?tab=cost-centres' },
    );
    expect(screen.getByRole('columnheader', { name: 'Maliyet (bin ₺)' })).toBeInTheDocument();
  });

  it('opens the budget preview from the tab strip', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FinancePage />, { route: '/sites/finance' });
    expect(screen.queryByRole('note')).not.toBeInTheDocument();

    await user.click(
      within(screen.getByRole('navigation', { name: 'Finance tabs' })).getByRole('button', {
        name: 'Budget',
      }),
    );
    previewOf('FARM-MEDIUM-439');
  });

  it('falls back to the overview for an unknown tab', () => {
    renderWithProviders(<FinancePage />, { route: '/sites/finance?tab=nope' });
    expect(
      within(screen.getByRole('navigation', { name: 'Finance tabs' })).getByRole('button', {
        name: 'Overview',
      }),
    ).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });
});
