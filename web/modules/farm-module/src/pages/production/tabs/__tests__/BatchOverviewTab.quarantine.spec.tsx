/**
 * Quarantine release from the batch overview (FARM-MEDIUM-402).
 *
 * A quarantined batch cannot be harvested (FARM-MEDIUM-401), so a manager must
 * be able to end the hold from the UI: the action shows only for a QUARANTINE
 * batch and only to a caller the releaseBatchFromQuarantine gate admits; it
 * asks for a reason and calls the dedicated mutation with one input.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

const canMutateMock = vi.fn((_name: string) => true);

vi.mock('@aquaculture/shared-ui', async () => ({
  ...(await (await import('../../../../test-utils/sharedUiMock')).createSharedUiMock()),
  useCanMutate: (name: string) => canMutateMock(name),
}));

import { requestMock } from '../../../../test-utils/sharedUiMock';
import { routeGraphql } from '../../../../test-utils/mockGraphqlClient';
import { renderWithProviders } from '../../../../test-utils/renderWithProviders';
import type { Batch } from '../../../../hooks/useBatches';
import BatchOverviewTab from '../BatchOverviewTab';

function batchIn(status: Batch['status']): Batch {
  const batch: Partial<Batch> = {
    id: 'batch-1',
    batchNumber: 'B-2026-001',
    speciesId: 'sp-1',
    initialQuantity: 1000,
    currentQuantity: 1000,
    totalMortality: 0,
    mortalityRate: 0,
    currentBiomassKg: 10,
    currentAvgWeightG: 10,
    daysInProduction: 3,
    stockedAt: '2026-10-01T00:00:00.000Z',
    fcr: {
      target: 1.1,
      actual: 0,
      theoretical: 1.1,
      isUserOverride: false,
      lastUpdatedAt: '2026-10-01T00:00:00.000Z',
    },
    status,
  };
  return batch as Batch;
}

beforeEach(() => {
  requestMock.mockReset();
  canMutateMock.mockImplementation(() => true);
  routeGraphql([
    {
      match: 'mutation ReleaseBatchFromQuarantine',
      result: {
        releaseBatchFromQuarantine: { id: 'batch-1', batchNumber: 'B-2026-001', status: 'ACTIVE' },
      },
    },
  ]);
});

describe('BatchOverviewTab — quarantine release', () => {
  it('offers the release only for a QUARANTINE batch', () => {
    const { unmount } = renderWithProviders(<BatchOverviewTab batch={batchIn('QUARANTINE')} />);
    expect(screen.getByRole('button', { name: 'Release from quarantine' })).toBeInTheDocument();
    unmount();

    renderWithProviders(<BatchOverviewTab batch={batchIn('ACTIVE')} />);
    expect(
      screen.queryByRole('button', { name: 'Release from quarantine' }),
    ).not.toBeInTheDocument();
  });

  it('hides the release from a caller the releaseBatchFromQuarantine gate refuses', () => {
    canMutateMock.mockImplementation((name: string) => name !== 'releaseBatchFromQuarantine');
    renderWithProviders(<BatchOverviewTab batch={batchIn('QUARANTINE')} />);

    expect(
      screen.queryByRole('button', { name: 'Release from quarantine' }),
    ).not.toBeInTheDocument();
    expect(canMutateMock).toHaveBeenCalledWith('releaseBatchFromQuarantine');
  });

  it('requires a reason, then sends the dedicated mutation with it', async () => {
    renderWithProviders(<BatchOverviewTab batch={batchIn('QUARANTINE')} />);
    fireEvent.click(screen.getByRole('button', { name: 'Release from quarantine' }));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Release batch' });

    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByRole('textbox'), {
      target: { value: 'Health inspection passed' },
    });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);

    await waitFor(() => {
      const call = requestMock.mock.calls.find(([query]) =>
        (query as string).includes('mutation ReleaseBatchFromQuarantine'),
      );
      expect(call?.[1]).toEqual({
        input: { batchId: 'batch-1', reason: 'Health inspection passed' },
      });
    });
  });
});
