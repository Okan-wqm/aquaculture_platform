/**
 * Real-modal failure-path test (federation-free vitest).
 *
 * The tab-level immediateReportSubmit.spec.tsx mocks the modals with a stub, so
 * it can only prove the TAB closes on success / stays open on failure — it does
 * NOT prove the SHIPPED modals surface a rejected submission. A modal that
 * silently swallows the thrown error (console.error + no UI) would leave the
 * operator believing a legally-immediate Mattilsynet report was filed.
 *
 * This test renders the REAL Welfare / Escape / Disease modals, drives each
 * form to a valid state, and rejects the injected onSubmit. It asserts:
 *   - a persistent role=alert region renders the rejection message, and
 *   - onClose is NOT called (the modal stays open).
 * It FAILS if any modal swallows the error.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WelfareEventModal } from '../WelfareEventModal';
import { EscapeReportModal } from '../EscapeReportModal';
import { DiseaseOutbreakModal } from '../DiseaseOutbreakModal';

// Empty tank/batch lists → modals render text-input fallbacks (no live data).
vi.mock('../../../../../hooks/useTanks', () => ({
  useTanksList: () => ({ data: { items: [] } }),
}));
vi.mock('../../../../../hooks/useBatches', () => ({
  useBatchList: () => ({ data: { items: [] } }),
}));

const REJECTION = 'Mattilsynet rejected the report';

afterEach(() => {
  vi.clearAllMocks();
});

async function addAction(user: ReturnType<typeof userEvent.setup>, placeholder: RegExp): Promise<void> {
  const input = screen.getByPlaceholderText(placeholder);
  await user.type(input, 'Immediate action taken');
  // Each "Add an action / measure" input is paired with an adjacent Add button.
  const addBtn = within(input.parentElement as HTMLElement).getByRole('button', { name: /^add$/i });
  await user.click(addBtn);
}

describe('immediate-report modals — real failure-path surfacing', () => {
  it('WelfareEventModal surfaces a rejected submit and stays open', async () => {
    const user = userEvent.setup({ delay: null });
    const onClose = vi.fn();
    const onSubmit = vi.fn().mockRejectedValue(new Error(REJECTION));

    render(
      <WelfareEventModal
        isOpen
        onClose={onClose}
        onSubmit={onSubmit}
        siteId="site-001"
        siteName="North Site"
      />,
    );

    // Default eventType = mortality_threshold → requires rate, count, + action.
    await user.type(screen.getByPlaceholderText(/e\.g\., 2\.5/i), '6.2');
    await user.type(screen.getByPlaceholderText(/total dead fish/i), '120');
    await addAction(user, /add an action taken/i);

    await user.click(screen.getByRole('button', { name: /submit report/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(REJECTION));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('EscapeReportModal surfaces a rejected submit and stays open', async () => {
    const user = userEvent.setup({ delay: null });
    const onClose = vi.fn();
    const onSubmit = vi.fn().mockRejectedValue(new Error(REJECTION));

    render(
      <EscapeReportModal
        isOpen
        onClose={onClose}
        onSubmit={onSubmit}
        siteId="site-001"
        siteName="North Site"
      />,
    );

    // No tanks → unit name is a free-text input ("e.g., Cage 3").
    await user.type(screen.getByPlaceholderText(/e\.g\., cage 3/i), 'Cage 3');
    await user.type(screen.getByPlaceholderText(/number escaped/i), '5000');
    await user.type(
      screen.getByPlaceholderText(/describe how the escape occurred/i),
      'Net torn during storm',
    );
    await addAction(user, /emergency net repair completed/i);

    await user.click(screen.getByRole('button', { name: /submit report/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(REJECTION));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('DiseaseOutbreakModal surfaces a rejected submit and stays open', async () => {
    const user = userEvent.setup({ delay: null });
    const onClose = vi.fn();
    const onSubmit = vi.fn().mockRejectedValue(new Error(REJECTION));

    render(
      <DiseaseOutbreakModal
        isOpen
        onClose={onClose}
        onSubmit={onSubmit}
        siteId="site-001"
        siteName="North Site"
      />,
    );

    // Pick a disease (default category C → first option after placeholder).
    const diseaseSelect = screen.getByRole('combobox');
    await user.selectOptions(diseaseSelect, 'PD');
    await user.type(screen.getByPlaceholderText(/number of fish/i), '2000');
    // Clinical sign + immediate action are both required.
    await user.click(screen.getByRole('button', { name: /lesions/i }));
    await addAction(user, /isolated affected cages/i);

    await user.click(screen.getByRole('button', { name: /submit report/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(REJECTION));
    expect(onClose).not.toHaveBeenCalled();
  });
});
