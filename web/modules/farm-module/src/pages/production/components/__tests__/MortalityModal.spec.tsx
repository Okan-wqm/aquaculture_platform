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

function renderModal(): { onSuccess: ReturnType<typeof vi.fn>; onClose: ReturnType<typeof vi.fn> } {
  const onSuccess = vi.fn();
  const onClose = vi.fn();
  renderWithProviders(
    <MortalityModal isOpen onClose={onClose} tank={TANK} onSuccess={onSuccess} />,
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
});
