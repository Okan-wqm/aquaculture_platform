/**
 * BatchFormModal specs.
 *
 * Regression guard for FARM-HIGH-098: the "New Batch" form used to hand-roll
 * its own `fixed inset-0` overlay + `inline-block ... transform` panel. Because
 * the panel was a NON-positioned in-flow box while the overlay was
 * `position: fixed` (positioned), CSS paint order drew the overlay ON TOP of
 * the panel — the form opened *behind* the dark backdrop and was unusable.
 *
 * The fix routes the modal through the shared `@aquaculture/shared-ui` `Modal`
 * primitive (portal to document.body + `relative` panel + role="dialog"), the
 * same primitive every sibling modal uses. These tests lock that in: if the
 * hand-rolled shell is ever reintroduced, the semantic dialog role disappears
 * and this suite fails.
 */
import { screen, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

vi.mock('@aquaculture/shared-ui', async () =>
  (await import('../../../../test-utils/sharedUiMock')).createSharedUiMock(),
);

import { requestMock } from '../../../../test-utils/sharedUiMock';
import { routeGraphql } from '../../../../test-utils/mockGraphqlClient';
import { renderWithProviders } from '../../../../test-utils/renderWithProviders';
import { BatchFormModal } from '../BatchFormModal';

beforeEach(() => {
  requestMock.mockReset();
  routeGraphql([
    { match: 'query GenerateBatchNumber', result: { generateBatchNumber: 'BATCH-TEST-001' } },
    { match: 'query AvailableTanks', result: { availableTanks: [] } },
    { match: 'query Suppliers', result: { suppliers: { items: [], total: 0 } } },
    { match: 'query SpeciesList', result: { speciesList: { items: [], total: 0 } } },
  ]);
});

describe('BatchFormModal', () => {
  it('renders through the shared Modal primitive (accessible dialog, not a hand-rolled backdrop)', async () => {
    renderWithProviders(
      <BatchFormModal isOpen onClose={vi.fn()} onSuccess={vi.fn()} />,
    );

    // Shared Modal exposes role="dialog" + aria-modal — the hand-rolled shell had neither.
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');

    // Title is driven by the Modal `title` prop.
    expect(screen.getByText('New Batch Input')).toBeInTheDocument();

    // Portaled to document.body (shared Modal uses createPortal), so it escapes
    // any transformed/overflow-clipped federated ancestor stacking context.
    expect(document.body).toContainElement(dialog);
  });

  it('moves the form content (tabs + submit) inside the Modal', async () => {
    renderWithProviders(
      <BatchFormModal isOpen onClose={vi.fn()} onSuccess={vi.fn()} />,
    );

    await screen.findByRole('dialog');

    // Tabs relocated from the hand-rolled header into the Modal body.
    expect(screen.getByRole('button', { name: 'Basic Info' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tank Allocation' })).toBeInTheDocument();

    // The submit action survives the shell swap.
    expect(screen.getByRole('button', { name: /create batch/i })).toBeInTheDocument();

    // Generated batch number is surfaced once the query resolves.
    await waitFor(() => expect(screen.getByText('BATCH-TEST-001')).toBeInTheDocument());
  });

  it('renders nothing when closed (Modal gates on isOpen)', () => {
    renderWithProviders(
      <BatchFormModal isOpen={false} onClose={vi.fn()} onSuccess={vi.fn()} />,
    );

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText('New Batch Input')).not.toBeInTheDocument();
  });
});
