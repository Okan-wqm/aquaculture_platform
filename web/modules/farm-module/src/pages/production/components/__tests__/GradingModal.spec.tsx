/**
 * GradingModal tests (FARM-MEDIUM-117, federation-free vitest).
 *
 * Exercises the REAL useRecordGrading hook → graphqlClient seam:
 *   - one recordGrading mutation per submit; the operation carries a top-level
 *     idempotency envelope AND each output carries its OWN distinct envelope
 *     (server-side each output is an independent transfer);
 *   - a failed submit retried without edits reuses the SAME clientCommandIds,
 *     so outputs already committed server-side are deduped, not double-moved;
 *   - over-stock totals block the submit client-side.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GradingModal } from '../GradingModal';
import type { TankBatch } from '../../types/batch.types';
import '@testing-library/jest-dom/vitest';

const { requestMock, toastMock } = vi.hoisted(() => ({
  requestMock: vi.fn(),
  toastMock: vi.fn(),
}));

vi.mock('@aquaculture/shared-ui', async () => {
  const actual =
    await vi.importActual<typeof import('@aquaculture/shared-ui')>('@aquaculture/shared-ui');
  return {
    ...actual,
    useAuth: () => ({
      token: 'jwt',
      tenantId: 'aaaaaaaa-1111-4222-8333-444444444444',
      isAuthenticated: true,
      isLoading: false,
    }),
    graphqlClient: { request: requestMock },
    useToast: () => ({ toast: toastMock }),
  };
});

const AVAILABLE_TANKS = [
  {
    id: 'tank-source', code: 'T1', name: 'Source Tank', volume: 100,
    maxBiomass: 1000, currentBiomass: 500, availableCapacity: 500,
    currentCount: 1000, maxDensity: 10, currentDensity: 5,
    status: 'ACTIVE', departmentId: 'dep-1', departmentName: 'Grow-out',
  },
  {
    id: 'tank-b', code: 'T2', name: 'Tank B', volume: 100,
    maxBiomass: 1000, currentBiomass: 0, availableCapacity: 1000,
    currentCount: 0, maxDensity: 10, currentDensity: 0,
    status: 'ACTIVE', departmentId: 'dep-1', departmentName: 'Grow-out',
  },
  {
    id: 'tank-c', code: 'T3', name: 'Tank C', volume: 100,
    maxBiomass: 1000, currentBiomass: 0, availableCapacity: 1000,
    currentCount: 0, maxDensity: 10, currentDensity: 0,
    status: 'ACTIVE', departmentId: 'dep-1', departmentName: 'Grow-out',
  },
];

const SOURCE_TANK: TankBatch = {
  id: 'tb-1',
  tenantId: 'aaaaaaaa-1111-4222-8333-444444444444',
  equipmentId: 'tank-source',
  tankName: 'Source Tank',
  tankCode: 'T1',
  primaryBatchId: 'batch-1',
  primaryBatchNumber: 'B-2026-001',
  totalQuantity: 1000,
  avgWeightG: 250,
  totalBiomassKg: 250,
  densityKgM3: 5,
  isMixedBatch: false,
  isOverCapacity: false,
};

interface RecordGradingVariables {
  input: {
    batchId: string;
    sourceTankId: string;
    // FARM-LOW-137: grading carries NO operation-level envelope.
    clientCommandId?: undefined;
    payloadHash?: undefined;
    outputs: Array<{
      destinationTankId: string;
      quantity: number;
      avgWeightG: number;
      clientCommandId: string;
      payloadHash: string;
      // FARM-MEDIUM-129: rowKey is an FE-only stable identity, stripped before the request.
      rowKey?: undefined;
    }>;
  };
}

function gradingCalls(): RecordGradingVariables[] {
  return requestMock.mock.calls
    .filter(([query]) => typeof query === 'string' && query.includes('mutation RecordGrading'))
    .map(([, variables]) => variables as RecordGradingVariables);
}

function renderModal(): { onSuccess: ReturnType<typeof vi.fn>; onClose: ReturnType<typeof vi.fn> } {
  const onSuccess = vi.fn();
  const onClose = vi.fn();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <GradingModal isOpen onClose={onClose} tank={SOURCE_TANK} onSuccess={onSuccess} />
    </QueryClientProvider>,
  );
  return { onSuccess, onClose };
}

async function fillTwoOutputs(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await waitFor(() => {
    expect(screen.getByLabelText(/^Destination Tank/, { selector: '#grading-destination-0' })).toBeInTheDocument();
  });
  await user.selectOptions(document.getElementById('grading-destination-0') as HTMLElement, 'tank-b');
  await user.selectOptions(document.getElementById('grading-destination-1') as HTMLElement, 'tank-c');
  await user.type(document.getElementById('grading-quantity-0') as HTMLElement, '400');
  await user.type(document.getElementById('grading-quantity-1') as HTMLElement, '600');
  await user.clear(document.getElementById('grading-avgweight-0') as HTMLElement);
  await user.type(document.getElementById('grading-avgweight-0') as HTMLElement, '180');
  await user.clear(document.getElementById('grading-avgweight-1') as HTMLElement);
  await user.type(document.getElementById('grading-avgweight-1') as HTMLElement, '320');
  await user.type(document.getElementById('grading-sizeclass-0') as HTMLElement, 'Small');
  await user.type(document.getElementById('grading-sizeclass-1') as HTMLElement, 'Large');
}

beforeEach(() => {
  requestMock.mockReset();
  toastMock.mockReset();
});

describe('GradingModal', () => {
  it('submits one recordGrading mutation with a distinct per-output envelope', async () => {
    requestMock.mockImplementation(async (query: string) => {
      if (query.includes('query AvailableTanks')) return { availableTanks: AVAILABLE_TANKS };
      if (query.includes('mutation RecordGrading')) {
        return {
          recordGrading: {
            id: 'batch-1', batchNumber: 'B-2026-001', currentQuantity: 0, currentBiomassKg: 0,
          },
        };
      }
      throw new Error(`Unexpected query: ${query}`);
    });

    const user = userEvent.setup();
    const { onSuccess } = renderModal();
    await fillTwoOutputs(user);
    await user.click(screen.getByRole('button', { name: 'Grade Fish' }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    const calls = gradingCalls();
    expect(calls).toHaveLength(1);

    const input = calls[0].input;
    expect(input.batchId).toBe('batch-1');
    expect(input.sourceTankId).toBe('tank-source');
    // FARM-LOW-137: no redundant operation-level envelope — only per-output.
    expect(input.clientCommandId).toBeUndefined();
    expect(input.payloadHash).toBeUndefined();

    expect(input.outputs).toHaveLength(2);
    expect(input.outputs[0]).toMatchObject({ destinationTankId: 'tank-b', quantity: 400, avgWeightG: 180 });
    expect(input.outputs[1]).toMatchObject({ destinationTankId: 'tank-c', quantity: 600, avgWeightG: 320 });
    for (const output of input.outputs) {
      expect(output.clientCommandId).toMatch(/[0-9a-f-]{36}/);
      expect(output.payloadHash).toMatch(/^[0-9a-f]{64}$/);
      // FARM-MEDIUM-129: the FE-only rowKey must never reach the server.
      expect(output.rowKey).toBeUndefined();
    }
    // The two per-output envelopes are independent of each other.
    const ids = new Set(input.outputs.map((o) => o.clientCommandId));
    expect(ids.size).toBe(2);
  });

  it('reuses the same command ids when a failed submit is retried unchanged', async () => {
    let failNext = true;
    requestMock.mockImplementation(async (query: string) => {
      if (query.includes('query AvailableTanks')) return { availableTanks: AVAILABLE_TANKS };
      if (query.includes('mutation RecordGrading')) {
        if (failNext) {
          failNext = false;
          throw new Error(
            'Grading stopped at output 2/2 (tank tank-c): capacity. 1 output(s) already committed: tank-b. Resubmit the remaining outputs only.',
          );
        }
        return {
          recordGrading: {
            id: 'batch-1', batchNumber: 'B-2026-001', currentQuantity: 0, currentBiomassKg: 0,
          },
        };
      }
      throw new Error(`Unexpected query: ${query}`);
    });

    const user = userEvent.setup();
    const { onSuccess } = renderModal();
    await fillTwoOutputs(user);

    await user.click(screen.getByRole('button', { name: 'Grade Fish' }));
    await waitFor(() => expect(toastMock).toHaveBeenCalledTimes(1));
    // The server's resume guidance is surfaced verbatim, not a generic message.
    expect(toastMock.mock.calls[0][0].description).toContain('already committed: tank-b');
    expect(onSuccess).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Grade Fish' }));
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));

    const calls = gradingCalls();
    expect(calls).toHaveLength(2);
    // FARM-MEDIUM-129: per-output ids are keyed by stable row identity, so an
    // unchanged resubmit reuses every output's id (server dedups the retry).
    expect(calls[1].input.outputs.map((o) => o.clientCommandId)).toEqual(
      calls[0].input.outputs.map((o) => o.clientCommandId),
    );
  });

  it('blocks submit when the graded total exceeds the source tank stock', async () => {
    requestMock.mockImplementation(async (query: string) => {
      if (query.includes('query AvailableTanks')) return { availableTanks: AVAILABLE_TANKS };
      throw new Error(`Unexpected query: ${query}`);
    });

    const user = userEvent.setup();
    renderModal();
    await waitFor(() => {
      expect(document.getElementById('grading-destination-0')).toBeInTheDocument();
    });
    await user.selectOptions(document.getElementById('grading-destination-0') as HTMLElement, 'tank-b');
    await user.selectOptions(document.getElementById('grading-destination-1') as HTMLElement, 'tank-c');
    await user.type(document.getElementById('grading-quantity-0') as HTMLElement, '800');
    await user.type(document.getElementById('grading-quantity-1') as HTMLElement, '900');

    expect(await screen.findByText(/exceeds source tank stock/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Grade Fish' })).toBeDisabled();
    expect(gradingCalls()).toHaveLength(0);
  });
});
