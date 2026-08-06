/**
 * RecordTransferPage contract tests — FARM-MEDIUM-050 regression guard.
 *
 * WHY: the mobile transfer form previously collected a free-form "Total biomass
 * (kg)" and sent it as `biomassKg`. The backend `TransferBatchInput` SSoT
 * (apps/farm-service/src/batch/dto/batch-resolver.dto.ts) has no such field — it
 * accepts `avgWeightG` (average weight per fish, grams) and derives total
 * biomass itself (`biomassKg = quantity * avgWeightG / 1000`,
 * transfer-batch.handler.ts). With the gateway ValidationPipe running
 * `forbidNonWhitelisted: true`, the stray `biomassKg` key produced intermittent
 * HTTP 400s on sync.
 *
 * These tests lock the converged contract: the enqueued `recordTransfer` payload
 * MUST carry `avgWeightG` and MUST NOT carry `biomassKg`, and the avg weight must
 * pre-fill from the source batch's known average so the common path needs no
 * manual entry.
 */

import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';
import type { ReactNode, ChangeEvent } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { RecordTransferPage } from '../RecordTransferPage';

// ---------------------------------------------------------------------------
// Hoisted mock state — `vi.hoisted` lifts these above the auto-hoisted
// `vi.mock` factories so the factories can close over them while imports stay
// in lint-clean order at the top of the file.
// ---------------------------------------------------------------------------
const h = vi.hoisted(() => {
  type BatchMetrics = {
    batchId: string;
    batchNumber: string;
    pieces: number;
    avgWeight: number | null;
    biomass: number;
    density: number;
    capacityUsedPercent: number;
    isOverCapacity: boolean;
    daysSinceStocking: number;
  };
  type Tank = {
    id: string;
    name: string;
    code: string;
    volume: number;
    status: string;
    currentBiomass: number;
    maxBiomass: number;
    batchMetrics: BatchMetrics | null;
  };
  const sourceMetrics: BatchMetrics = {
    batchId: 'batch-1',
    batchNumber: 'B-2026-001',
    pieces: 500,
    avgWeight: 200,
    biomass: 100,
    density: 1,
    capacityUsedPercent: 50,
    isOverCapacity: false,
    daysSinceStocking: 30,
  };
  const sourceWithAvgWeight: Tank = {
    id: 'tank-1',
    name: 'Tank A',
    code: 'TA',
    volume: 100,
    status: 'ACTIVE',
    currentBiomass: 100,
    maxBiomass: 200,
    batchMetrics: sourceMetrics,
  };
  const emptyDestination: Tank = {
    id: 'tank-2',
    name: 'Tank B',
    code: 'TB',
    volume: 100,
    status: 'ACTIVE',
    currentBiomass: 0,
    maxBiomass: 200,
    batchMetrics: null,
  };
  // Separate fixture: source whose batch has no known average weight — exercises
  // the "no prefill, user enters nothing" branch without mutating the shared
  // happy-path tank (avoids a non-null-assertion to reach into it).
  const sourceWithoutAvgWeight: Tank = {
    ...sourceWithAvgWeight,
    batchMetrics: { ...sourceMetrics, avgWeight: null },
  };
  return {
    addToQueue: vi.fn<
      (op: string, payload: Record<string, unknown>) => Promise<{ status: string; id: string }>
    >(() => Promise.resolve({ status: 'queued', id: 'op-555' })),
    isOnline: true,
    tanks: [sourceWithAvgWeight, emptyDestination],
    sourceWithAvgWeight,
    sourceWithoutAvgWeight,
    emptyDestination,
  };
});

vi.mock('@/hooks/useOfflineQueue', () => ({
  useOfflineQueue: () => ({
    addToQueue: h.addToQueue,
    isOnline: h.isOnline,
    pendingCount: 0,
    pendingOperations: [],
    isSyncing: false,
    syncError: null,
    syncNow: vi.fn(),
    removeFromQueue: vi.fn(),
    refreshQueue: vi.fn(),
    clearError: vi.fn(),
    getSyncStatus: vi.fn().mockReturnValue('pending'),
  }),
}));

vi.mock('@/hooks/useTanks', () => ({
  useTanks: () => ({ data: h.tanks, isLoading: false, error: null }),
}));

vi.mock('@/components/QueuedStatusBadge', () => ({
  QueuedStatusBadge: ({ operationId }: { operationId: string }) => (
    <div data-testid="queued-badge">queued:{operationId}</div>
  ),
}));

// konsta/react uses useRef internally which trips on the dual-React copy.
// Stub the components the page uses so tests run against plain DOM nodes.
vi.mock('konsta/react', () => ({
  List: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  BlockTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  ListInput: ({
    type,
    value,
    onChange,
    onInput,
    children,
    placeholder,
  }: {
    type?: string;
    value?: string;
    onChange?: (e: ChangeEvent<HTMLSelectElement>) => void;
    onInput?: (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
    children?: ReactNode;
    placeholder?: string;
  }) => {
    if (type === 'select') {
      return (
        <select value={value} onChange={onChange}>
          {children}
        </select>
      );
    }
    if (type === 'textarea') {
      return <textarea value={value} onChange={onInput} placeholder={placeholder} />;
    }
    return (
      <input
        type={type || 'text'}
        value={value ?? ''}
        onChange={onInput}
        placeholder={placeholder}
      />
    );
  },
}));

// lucide-react icons use forwardRef; stub each one the page transitively needs.
vi.mock('lucide-react', () => {
  const Stub = (): ReactNode => <svg data-testid="icon" />;
  return {
    ArrowLeft: Stub,
    ArrowLeftRight: Stub,
    AlertCircle: Stub,
    ChevronRight: Stub,
  };
});

// Fully stub react-router-dom — importActual pulls real react-router which
// attempts useRef() against the local (null) React instance (dual-React quirk).
vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
}));

beforeEach(() => {
  h.addToQueue.mockClear();
  // Restore the happy-path source-tank fixture in case a prior test swapped it.
  h.tanks[0] = h.sourceWithAvgWeight;
});

// vitest.config has `globals: false`, so auto-cleanup is not wired up.
afterEach(() => {
  cleanup();
});

/**
 * Runs a synchronous DOM action inside `act` and then awaits a microtask flush
 * so the page's effects (e.g. the avgWeightG prefill effect that fires after a
 * source-tank change) settle before the next query reads state. The genuine
 * `await` keeps the helper `require-await`-clean while still flushing effects.
 */
async function flushAct(action: () => void): Promise<void> {
  await act(async () => {
    action();
    await Promise.resolve();
  });
}

/**
 * Drives the form to the confirm screen and submits, returning the enqueued
 * payload. Selects source tank-1 (has batch), destination tank-2 (empty), and
 * sets quantity. Avg weight is left to its pre-filled default unless overridden.
 */
async function submitTransfer(opts?: {
  avgWeightOverride?: string;
}): Promise<Record<string, unknown>> {
  // selects[0] = source tank, selects[1] = destination tank
  await flushAct(() => {
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'tank-1' } });
  });
  // Let the avgWeightG prefill effect (which fires after the source-tank change)
  // fully settle before continuing. Without this, the late re-render can detach
  // nodes captured by later queries and the submit silently no-ops.
  await waitFor(() => {
    const reviewBtn = screen.getByRole('button', { name: /Review Transfer/i });
    expect(reviewBtn).toBeDefined();
  });
  await flushAct(() => {
    fireEvent.change(screen.getAllByRole('combobox')[1], { target: { value: 'tank-2' } });
  });
  await flushAct(() => {
    fireEvent.input(screen.getByPlaceholderText(/Number of pieces to transfer/i), {
      target: { value: '100' },
    });
  });

  if (opts?.avgWeightOverride !== undefined) {
    await flushAct(() => {
      fireEvent.input(screen.getByPlaceholderText(/Average weight per fish in grams/i), {
        target: { value: opts.avgWeightOverride },
      });
    });
  }

  await flushAct(() => {
    fireEvent.click(screen.getByRole('button', { name: /Review Transfer/i }));
  });
  await screen.findByRole('button', { name: /Confirm Transfer/i });
  // Re-query the confirm button inside the act so a late re-render cannot leave
  // us clicking a detached node.
  await flushAct(() => {
    fireEvent.click(screen.getByRole('button', { name: /Confirm Transfer/i }));
  });

  await waitFor(() => expect(h.addToQueue).toHaveBeenCalledTimes(1));
  const [opName, payload] = h.addToQueue.mock.calls[0] ?? [];
  expect(opName).toBe('recordTransfer');
  return payload;
}

// Each case drives the form through two render-heavy steps (entry -> confirm)
// under the konsta/dual-React quirk, awaiting several effect-settling flushes
// (notably the avgWeightG prefill effect). Under CI load that exceeds vitest's
// default 5s per-test ceiling, so raise the timeout suite-wide. This is a test
// harness concession to render latency, not a slow code path in the page.
describe(
  'RecordTransferPage — backend TransferBatchInput contract (FARM-MEDIUM-050)',
  { timeout: 20000 },
  () => {
    it('enqueues avgWeightG and never the rejected biomassKg field', async () => {
      render(<RecordTransferPage />);
      const payload = await submitTransfer();

      expect(payload).toMatchObject({
        batchId: 'batch-1',
        sourceTankId: 'tank-1',
        destinationTankId: 'tank-2',
        quantity: 100,
      });
      // The whole point of the fix: avgWeightG present, biomassKg absent.
      expect(payload.avgWeightG).toBe(200);
      expect('biomassKg' in payload).toBe(false);
    });

    it('pre-fills avgWeightG from the source batch average (zero manual entry)', async () => {
      render(<RecordTransferPage />);
      const payload = await submitTransfer();
      // 200 g/fish comes straight from sourceMetrics.avgWeight — the same backend
      // SSoT field surfaced via useTanks — not from any user input.
      expect(payload.avgWeightG).toBe(200);
    });

    it('honours a manual avgWeightG override for a differently-sized sub-population', async () => {
      render(<RecordTransferPage />);
      const payload = await submitTransfer({ avgWeightOverride: '150' });
      expect(payload.avgWeightG).toBe(150);
      expect('biomassKg' in payload).toBe(false);
    });

    it('omits avgWeightG when no source average exists and the user enters none', async () => {
      // Source batch with avgWeight null → no prefill; user leaves the field blank.
      h.tanks[0] = h.sourceWithoutAvgWeight;
      render(<RecordTransferPage />);
      const payload = await submitTransfer();
      expect(payload.avgWeightG).toBeUndefined();
      expect('biomassKg' in payload).toBe(false);
    });

    it('exposes an Average Weight field, not a Biomass field, in the entry form', () => {
      render(<RecordTransferPage />);
      expect(screen.getByPlaceholderText(/Average weight per fish in grams/i)).toBeTruthy();
      expect(screen.queryByPlaceholderText(/Total biomass kg/i)).toBeNull();
    });

    // Tier-1 guard: the page binds its enqueued payload to the `TransferInput`
    // SSoT type (buildPayload(): TransferInput), so tsc excess-property checking
    // rejects any non-contract key at compile time. This runtime test pins the
    // SAME invariant — the enqueued payload carries ONLY the whitelisted
    // TransferInput keys — so a future refactor that re-inlines an untyped literal
    // (re-opening the door to a stray `biomassKg`) fails the suite, not just tsc.
    it('enqueues exactly the whitelisted TransferInput keys and nothing else', async () => {
      render(<RecordTransferPage />);
      const payload = await submitTransfer();

      const allowedKeys = [
        'batchId',
        'sourceTankId',
        'destinationTankId',
        'quantity',
        'avgWeightG',
        'transferReason',
        'transferredAt',
      ].sort();
      // Keys with an `undefined` value (e.g. an omitted optional) are not wire
      // fields — JSON.stringify drops them — so compare on present keys only.
      const presentKeys = Object.keys(payload)
        .filter((k) => payload[k] !== undefined)
        .sort();
      presentKeys.forEach((k) => expect(allowedKeys).toContain(k));
      // The four required fields must always be present.
      expect(presentKeys).toEqual(
        expect.arrayContaining(['batchId', 'sourceTankId', 'destinationTankId', 'quantity']),
      );
    });
  },
);
