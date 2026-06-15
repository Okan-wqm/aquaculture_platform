/**
 * RecordEntityPage shell tests — AUDIT-MEDIUM-012 regression guard.
 *
 * Covers the extracted shell's two-step form flow (entry → confirm → submit)
 * via RecordCullPage as a representative consumer. The goal is to lock the
 * step-machine contract so the 3 consumer pages (cull / mortality / harvest)
 * stay behavior-compatible with the pre-extraction duplicated code.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must come before imports that transitively resolve them.
// Dual-React-instance mitigation: we mock every downstream hook the shell
// touches so the test does not need the full OfflineProvider + QueryClient
// tree (see vitest.config.ts note).
// ---------------------------------------------------------------------------

// FE-HIGH-050: addToQueue resolves a discriminated AddToQueueResult. Typed args so
// mock.calls is `[string, Record<string, unknown>][]` and no cast is needed to read them.
const mockAddToQueue = vi.fn<
  (op: string, payload: Record<string, unknown>) => Promise<{ status: string; id: string }>
>(() => Promise.resolve({ status: 'queued', id: 'op-123' }));
let mockIsOnline = true;

vi.mock('@/hooks/useOfflineQueue', () => ({
  useOfflineQueue: () => ({
    addToQueue: mockAddToQueue,
    isOnline: mockIsOnline,
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

const mockTanks = [
  {
    id: 'tank-1',
    name: 'Tank A',
    code: 'TA',
    volume: 100,
    status: 'ACTIVE',
    currentBiomass: 10,
    maxBiomass: 100,
    batchMetrics: {
      batchId: 'batch-1',
      batchNumber: 'B-2026-001',
      pieces: 500,
      avgWeight: 200,
      biomass: 100,
      density: 1,
      capacityUsedPercent: 10,
      isOverCapacity: false,
      daysSinceStocking: 30,
    },
  },
];

vi.mock('@/hooks/useTanks', () => ({
  useTanks: () => ({ data: mockTanks, isLoading: false, error: null }),
}));

vi.mock('@/components/QueuedStatusBadge', () => ({
  QueuedStatusBadge: ({ operationId }: { operationId: string }) => (
    <div data-testid="queued-badge">queued:{operationId}</div>
  ),
}));

// konsta/react uses useRef internally which trips on the dual-React copy.
// Stub the 3 components actually used by the pages so tests work against
// plain DOM nodes (behavior contract, not styling).
vi.mock('konsta/react', () => ({
  List: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  BlockTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  ListInput: ({
    type,
    value,
    onChange,
    onInput,
    children,
    placeholder,
    label,
  }: {
    type?: string;
    value?: string;
    onChange?: (e: React.ChangeEvent<HTMLSelectElement>) => void;
    onInput?: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
    children?: React.ReactNode;
    placeholder?: string;
    label?: string;
  }) => {
    if (type === 'select') {
      return (
        <label>
          {label}
          <select value={value} onChange={onChange}>
            {children}
          </select>
        </label>
      );
    }
    if (type === 'textarea') {
      return (
        <label>
          {label}
          <textarea value={value} onChange={onInput} placeholder={placeholder} />
        </label>
      );
    }
    return (
      <label>
        {label}
        <input type={type || 'text'} value={value ?? ''} onChange={onInput} placeholder={placeholder} />
      </label>
    );
  },
}));

// lucide-react icons use forwardRef; stub each one the pages transitively need.
vi.mock('lucide-react', () => {
  const Stub = () => <svg data-testid="icon" />;
  return {
    ArrowLeft: Stub,
    AlertCircle: Stub,
    Minus: Stub,
    Plus: Stub,
    ChevronRight: Stub,
    Scissors: Stub,
    Skull: Stub,
    Package: Stub,
  };
});

// clsx — plain string joiner, avoid node_modules traversal
vi.mock('clsx', () => ({
  clsx: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

// Fully stub react-router-dom — importActual pulls real react-router which
// attempts to useRef() against the local (null) React instance due to the
// dual-React-copy quirk in this monorepo (see vitest.config.ts).
const mockNavigate = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
  useParams: () => ({}),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';
import { RecordCullPage } from '../../cull/RecordCullPage';
import { RecordMortalityPage } from '../../mortality/RecordMortalityPage';
import { RecordHarvestPage } from '../../harvest/RecordHarvestPage';

function renderPage(page: React.ReactElement) {
  return render(page);
}

beforeEach(() => {
  mockAddToQueue.mockClear();
  mockNavigate.mockClear();
  mockIsOnline = true;
});

// vitest.config has `globals: false`, so @testing-library/react's auto-cleanup
// hook is not wired up — without explicit cleanup, mounted DOM bleeds across
// tests and `getByRole` finds stale nodes from prior renders.
afterEach(() => {
  cleanup();
});

describe('RecordEntityPage shell — entry → confirm → submit', () => {
  it('RecordCullPage: Review is disabled until a tank with batch is selected', () => {
    renderPage(<RecordCullPage />);
    const reviewBtn = screen.getByRole('button', { name: /Review .* Culled Fish/i });
    expect(reviewBtn).toHaveProperty('disabled', true);
  });

  it('RecordCullPage: selecting tank + clicking Review transitions to confirm screen', async () => {
    renderPage(<RecordCullPage />);

    const select = screen.getByRole('combobox');
    await act(async () => {
      fireEvent.change(select, { target: { value: 'tank-1' } });
    });

    const reviewBtn = screen.getByRole('button', { name: /Review .* Culled Fish/i });
    await waitFor(() => expect(reviewBtn).toHaveProperty('disabled', false));

    await act(async () => {
      fireEvent.click(reviewBtn);
    });

    // Confirm screen should now show "Cull Summary"
    expect(await screen.findByText(/Cull Summary/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Confirm & Record/i })).toBeTruthy();
  });

  it('RecordCullPage: Confirm & Record enqueues the cull payload', async () => {
    renderPage(<RecordCullPage />);

    const select = screen.getByRole('combobox');
    await act(async () => {
      fireEvent.change(select, { target: { value: 'tank-1' } });
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Review .* Culled Fish/i }));
    });

    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: /Confirm & Record/i }));
    });

    await waitFor(() => {
      expect(mockAddToQueue).toHaveBeenCalledTimes(1);
    });
    const [opName, payload] = mockAddToQueue.mock.calls[0] ?? [];
    expect(opName).toBe('recordCull');
    expect(payload).toMatchObject({
      batchId: 'batch-1',
      tankId: 'tank-1',
      quantity: 1,
      reason: 'GRADING',
    });
    // Success screen swaps in via QueuedStatusBadge
    expect((await screen.findByTestId('queued-badge')).textContent).toContain('queued:op-123');
  });

  it('RecordCullPage: Go Back from confirm returns to entry step', async () => {
    renderPage(<RecordCullPage />);
    await act(async () => {
      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'tank-1' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Review .* Culled Fish/i }));
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: /Go Back & Edit/i }));
    });
    // Back on entry screen
    expect(screen.getByRole('button', { name: /Review .* Culled Fish/i })).toBeTruthy();
  });

  it('RecordMortalityPage: enqueues recordMortality with observedAt date', async () => {
    renderPage(<RecordMortalityPage />);
    await act(async () => {
      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'tank-1' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Review .* Dead Fish/i }));
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: /Confirm & Record/i }));
    });

    await waitFor(() => expect(mockAddToQueue).toHaveBeenCalledTimes(1));
    const firstCall = mockAddToQueue.mock.calls[0];
    if (!firstCall) throw new Error('addToQueue was not called');
    const [opName, payload] = firstCall;
    expect(opName).toBe('recordMortality');
    expect(payload).toMatchObject({
      batchId: 'batch-1',
      tankId: 'tank-1',
      reason: 'UNKNOWN',
    });
    expect((payload as { observedAt: string }).observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('RecordHarvestPage: requires quantity + avg weight before Review enables', async () => {
    renderPage(<RecordHarvestPage />);

    // Select tank (triggers avgWeight prefill from metrics)
    await act(async () => {
      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'tank-1' } });
    });

    const reviewBtn = screen.getByRole('button', { name: /Review Harvest/i });
    // Even after tank selection, quantity is empty → still disabled
    expect(reviewBtn).toHaveProperty('disabled', true);

    // Enter quantity → review enables (avgWeight was prefilled to 200)
    const quantityInput = screen.getByPlaceholderText(/Enter fish count/i);
    await act(async () => {
      fireEvent.input(quantityInput, { target: { value: '100' } });
    });
    await waitFor(() => expect(reviewBtn).toHaveProperty('disabled', false));
  });

  it('RecordHarvestPage: enqueues createHarvestRecord with biomass math', async () => {
    renderPage(<RecordHarvestPage />);

    await act(async () => {
      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'tank-1' } });
    });
    await act(async () => {
      fireEvent.input(screen.getByPlaceholderText(/Enter fish count/i), {
        target: { value: '100' },
      });
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Review Harvest/i }));
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: /Confirm & Record Harvest/i }));
    });

    await waitFor(() => expect(mockAddToQueue).toHaveBeenCalledTimes(1));
    const firstCall = mockAddToQueue.mock.calls[0];
    if (!firstCall) throw new Error('addToQueue was not called');
    const [opName, rawPayload] = firstCall;
    const payload = rawPayload as {
      quantityHarvested: number;
      averageWeight: number;
      totalBiomass: number;
      qualityGrade: string;
    };
    expect(opName).toBe('createHarvestRecord');
    expect(payload.quantityHarvested).toBe(100);
    expect(payload.averageWeight).toBe(200);
    expect(payload.totalBiomass).toBeCloseTo((100 * 200) / 1000, 5);
    expect(payload.qualityGrade).toBe('GRADE_A');
  });
});

describe('RecordEntityPage shell — duplicate (FE-HIGH-050)', () => {
  it('renders "Already recorded" instead of a success badge when the submit is deduped', async () => {
    // The queue collapsed a double-tap onto an existing op — status 'duplicate'.
    mockAddToQueue.mockResolvedValueOnce({ status: 'duplicate', id: 'op-existing' });
    renderPage(<RecordCullPage />);

    await act(async () => {
      fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'tank-1' } });
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: /Review .* Culled Fish/i }));
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: /Confirm & Record/i }));
    });

    // The honest "Already recorded" notice shows — NOT the queued success badge.
    expect(await screen.findByText(/Already recorded/i)).toBeTruthy();
    expect(screen.queryByTestId('queued-badge')).toBeNull();
  });
});

describe('RecordEntityPage shell — failure path', () => {
  it('surfaces queue errors on confirm screen without leaving the step machine broken', async () => {
    mockAddToQueue.mockRejectedValueOnce(new Error('queue offline'));
    renderPage(<RecordCullPage />);

    await act(async () => {
      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'tank-1' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Review .* Culled Fish/i }));
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: /Confirm & Record/i }));
    });

    // Error surfaces back on entry step — shell resets to 'entry' on failure
    await waitFor(() => {
      expect(screen.getByText(/queue offline/i)).toBeTruthy();
    });
    expect(screen.getByRole('button', { name: /Review .* Culled Fish/i })).toBeTruthy();
  });
});
