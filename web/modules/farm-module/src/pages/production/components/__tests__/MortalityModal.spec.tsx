/**
 * MortalityModal specs (FARM-MEDIUM-120 batch 2).
 *
 * Exercises the REAL useRecordMortality hook → graphqlClient seam: the submit
 * carries the at-most-once envelope (clientCommandId + payloadHash), a failed
 * submit keeps the modal open with an error toast, and validation blocks
 * over-stock quantities client-side.
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

vi.mock('@aquaculture/shared-ui', async () =>
  (await import('../../../../test-utils/sharedUiMock')).createSharedUiMock(),
);

import { requestMock, toastMock } from '../../../../test-utils/sharedUiMock';
import { routeGraphql } from '../../../../test-utils/mockGraphqlClient';
import { renderWithProviders } from '../../../../test-utils/renderWithProviders';
import { MortalityModal } from '../MortalityModal';
import type { TankBatch } from '../../types/batch.types';

const TANK: TankBatch = {
  id: 'tb-1',
  tenantId: 'aaaaaaaa-1111-4222-8333-444444444444',
  equipmentId: 'tank-1',
  tankName: 'Grow-out Tank A',
  tankCode: 'GT-A',
  primaryBatchId: 'batch-1',
  primaryBatchNumber: 'B-2026-001',
  totalQuantity: 1000,
  avgWeightG: 250,
  totalBiomassKg: 250,
  densityKgM3: 5,
  isMixedBatch: false,
  isOverCapacity: false,
};

// A combined tank (B-1 primary 1000 fish + B-2 500 fish = 1500 total). The
// operation must attribute to the SELECTED batch and scope quantity to its share.
const COMBINED_TANK: TankBatch = {
  ...TANK,
  totalQuantity: 1500,
  totalBiomassKg: 350,
  isMixedBatch: true,
  batchDetails: [
    { batchId: 'batch-1', batchNumber: 'B-1', quantity: 1000, avgWeightG: 250, biomassKg: 250, percentageOfTank: 66.7 },
    { batchId: 'batch-2', batchNumber: 'B-2', quantity: 500, avgWeightG: 200, biomassKg: 100, percentageOfTank: 33.3 },
  ],
};

interface MortalityVariables {
  input: {
    batchId: string;
    tankId: string;
    quantity: number;
    reason: string;
    clientCommandId: string;
    payloadHash: string;
  };
}

function mortalityCalls(): MortalityVariables[] {
  return requestMock.mock.calls
    .filter(([query]) => typeof query === 'string' && query.includes('mutation RecordMortality'))
    .map(([, variables]) => variables as MortalityVariables);
}

function renderModal(
  tank: TankBatch = TANK,
): { onSuccess: ReturnType<typeof vi.fn>; onClose: ReturnType<typeof vi.fn> } {
  const onSuccess = vi.fn();
  const onClose = vi.fn();
  renderWithProviders(
    <MortalityModal isOpen onClose={onClose} tank={tank} onSuccess={onSuccess} />,
  );
  return { onSuccess, onClose };
}

async function fillValidForm(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(document.getElementById('quantity') as HTMLElement, '25');
  await user.type(document.getElementById('notes') as HTMLElement, 'Low oxygen overnight');
}

beforeEach(() => {
  requestMock.mockReset();
  toastMock.mockReset();
});

describe('MortalityModal', () => {
  it('submits recordMortality with the at-most-once envelope attached', async () => {
    routeGraphql([
      {
        match: 'mutation RecordMortality',
        result: {
          recordMortality: {
            id: 'batch-1',
            batchNumber: 'B-2026-001',
            currentQuantity: 975,
            totalMortality: 25,
            retentionRate: 97.5,
            mortalityRate: 2.5,
            currentBiomassKg: 243.75,
          },
        },
      },
    ]);
    const user = userEvent.setup();
    const { onSuccess } = renderModal();

    await fillValidForm(user);
    await user.click(screen.getByRole('button', { name: /Record Mortality/ }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    const calls = mortalityCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].input).toMatchObject({
      batchId: 'batch-1',
      tankId: 'tank-1',
      quantity: 25,
    });
    expect(calls[0].input.clientCommandId).toMatch(/[0-9a-f-]{36}/);
    expect(calls[0].input.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps the modal open and surfaces an error toast when the mutation fails', async () => {
    routeGraphql([]); // mutation unrouted → throws
    const user = userEvent.setup();
    const { onSuccess, onClose } = renderModal();

    await fillValidForm(user);
    await user.click(screen.getByRole('button', { name: /Record Mortality/ }));

    await waitFor(() => expect(toastMock).toHaveBeenCalled());
    expect(toastMock.mock.calls[0][0].variant).toBe('error');
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('blocks quantities above the tank stock client-side', async () => {
    const user = userEvent.setup();
    renderModal();

    await user.type(document.getElementById('quantity') as HTMLElement, '5000');
    await user.type(document.getElementById('notes') as HTMLElement, 'typo');

    expect(await screen.findByText(/cannot exceed/i)).toBeInTheDocument();
    expect(mortalityCalls()).toHaveLength(0);
  });

  // ── Combined-batch scoping (B-1 + B-2) ──────────────────────────────────────
  it('shows no batch-scope selector for a single-batch tank', () => {
    renderModal();
    expect(document.getElementById('batch-scope')).toBeNull();
  });

  it('attributes the mortality to the SELECTED batch, not the primary', async () => {
    routeGraphql([
      {
        match: 'mutation RecordMortality',
        result: {
          recordMortality: {
            id: 'batch-2',
            batchNumber: 'B-2',
            currentQuantity: 475,
            totalMortality: 25,
            retentionRate: 95,
            mortalityRate: 5,
            currentBiomassKg: 95,
          },
        },
      },
    ]);
    const user = userEvent.setup();
    const { onSuccess } = renderModal(COMBINED_TANK);

    await user.selectOptions(document.getElementById('batch-scope') as HTMLElement, 'batch-2');
    await fillValidForm(user);
    await user.click(screen.getByRole('button', { name: /Record Mortality/ }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    const calls = mortalityCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].input.batchId).toBe('batch-2');
  });

  it('scopes over-stock validation to the selected batch share (800 > B-2 500, < tank 1500)', async () => {
    const user = userEvent.setup();
    renderModal(COMBINED_TANK);

    await user.selectOptions(document.getElementById('batch-scope') as HTMLElement, 'batch-2');
    await user.type(document.getElementById('quantity') as HTMLElement, '800');
    await user.type(document.getElementById('notes') as HTMLElement, 'scoped');

    // 800 is under the 1500 tank total but over B-2's 500 share → blocked.
    expect(await screen.findByText(/cannot exceed batch stock/i)).toBeInTheDocument();
    expect(mortalityCalls()).toHaveLength(0);
  });
});
