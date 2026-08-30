/**
 * LiceCountPage contract tests (FARM-HIGH-214 / RPT-019).
 *
 * Locks the enqueued `recordLiceCount` payload to the backend
 * RecordLiceCountInput SSoT: siteId comes from the SELECTED TANK's inventory
 * snapshot (never operator-entered), all three lice stages are required
 * (0 is a valid count — absent is not), and only whitelisted keys ride the
 * wire (gateway ValidationPipe runs forbidNonWhitelisted).
 */

import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';
import type { ReactNode, ChangeEvent } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { LiceCountPage } from '../LiceCountPage';

const h = vi.hoisted(() => {
  const metrics = {
    batchId: 'batch-1',
    batchNumber: 'B-2026-001',
    speciesId: 'species-1',
    speciesName: 'Atlantic Salmon',
    pieces: 500,
    avgWeight: 200,
    biomass: 100,
    density: 1,
    capacityUsedPercent: 50,
    isOverCapacity: false,
    daysSinceStocking: 30,
  };
  const tankWithSite = {
    id: 'tank-1',
    name: 'Pen 1',
    code: 'P1',
    volume: 100,
    status: 'ACTIVE',
    currentBiomass: 100,
    maxBiomass: 200,
    siteId: 'site-1',
    batchMetrics: metrics,
  };
  const tankWithoutSite = { ...tankWithSite, id: 'tank-2', name: 'Pen 2', siteId: null };
  return {
    addToQueue: vi.fn<
      (op: string, payload: Record<string, unknown>) => Promise<{ status: string; id: string }>
    >(() => Promise.resolve({ status: 'queued', id: 'op-777' })),
    tanks: [tankWithSite, tankWithoutSite],
  };
});

vi.mock('@/hooks/useOfflineQueue', () => ({
  useOfflineQueue: () => ({
    addToQueue: h.addToQueue,
    isOnline: true,
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

// PhotoCaptureField (added FARM incident photo capture) pulls in the network
// status + upload hooks — stub them so the page renders deterministically online
// without a real presign/PUT.
vi.mock('@/hooks/useNetworkStatus', () => ({
  useNetworkStatus: () => true,
}));

vi.mock('@/hooks/useIncidentMediaUpload', () => ({
  useIncidentMediaUpload: () => ({
    uploadPhoto: vi.fn(),
    isUploading: false,
    progress: 0,
    error: null,
  }),
}));

vi.mock('@/components/QueuedStatusBadge', () => ({
  QueuedStatusBadge: ({ operationId }: { operationId: string }) => (
    <div data-testid="queued-badge">queued:{operationId}</div>
  ),
}));

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
    label,
  }: {
    type?: string;
    value?: string | number;
    onChange?: (e: ChangeEvent<HTMLSelectElement>) => void;
    onInput?: (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
    children?: ReactNode;
    placeholder?: string;
    label?: string;
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
        aria-label={label}
        value={value ?? ''}
        onChange={onInput}
        placeholder={placeholder}
      />
    );
  },
}));

vi.mock('lucide-react', () => {
  const Stub = (): ReactNode => <svg data-testid="icon" />;
  return {
    ArrowLeft: Stub,
    AlertCircle: Stub,
    Bug: Stub,
    Camera: Stub,
    ChevronRight: Stub,
    ImageOff: Stub,
    Loader2: Stub,
    Minus: Stub,
    Plus: Stub,
    X: Stub,
  };
});

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
}));

beforeEach(() => {
  h.addToQueue.mockClear();
});

afterEach(() => {
  cleanup();
});

async function flushAct(action: () => void): Promise<void> {
  await act(async () => {
    action();
    await Promise.resolve();
  });
}

async function fillStages(values: {
  adult: string;
  mobile: string;
  attached: string;
}): Promise<void> {
  await flushAct(() => {
    fireEvent.change(screen.getByLabelText(/Adult female lice/i), {
      target: { value: values.adult },
    });
  });
  await flushAct(() => {
    fireEvent.change(screen.getByLabelText(/Mobile lice/i), { target: { value: values.mobile } });
  });
  await flushAct(() => {
    fireEvent.change(screen.getByLabelText(/Attached lice/i), {
      target: { value: values.attached },
    });
  });
}

async function submit(): Promise<Record<string, unknown>> {
  await flushAct(() => {
    fireEvent.click(screen.getByRole('button', { name: /Review Lice Count/i }));
  });
  await screen.findByRole('button', { name: /Confirm & Record/i });
  await flushAct(() => {
    fireEvent.click(screen.getByRole('button', { name: /Confirm & Record/i }));
  });
  await waitFor(() => expect(h.addToQueue).toHaveBeenCalledTimes(1));
  const [opName, payload] = h.addToQueue.mock.calls[0] ?? [];
  expect(opName).toBe('recordLiceCount');
  return payload;
}

describe(
  'LiceCountPage — RecordLiceCountInput contract (FARM-HIGH-214)',
  { timeout: 20000 },
  () => {
    it('enqueues siteId from the selected tank plus all three stages (decimals preserved)', async () => {
      render(<LiceCountPage />);
      await flushAct(() => {
        fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'tank-1' } });
      });
      await fillStages({ adult: '0.15', mobile: '1.2', attached: '0' });

      const payload = await submit();

      expect(payload).toMatchObject({
        siteId: 'site-1',
        tankId: 'tank-1',
        batchId: 'batch-1',
        adultFemaleLice: 0.15,
        mobileLice: 1.2,
        attachedLice: 0,
        fishSampled: 20,
      });
      expect(String(payload.countDate)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('enqueues exactly the whitelisted RecordLiceCountInput keys', async () => {
      render(<LiceCountPage />);
      await flushAct(() => {
        fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'tank-1' } });
      });
      await fillStages({ adult: '0.1', mobile: '0.5', attached: '0.2' });
      const payload = await submit();

      const allowedKeys = [
        'siteId',
        'tankId',
        'batchId',
        'countDate',
        'adultFemaleLice',
        'mobileLice',
        'attachedLice',
        'fishSampled',
        'seaTemperatureC',
        'notes',
        'mediaKeys',
      ];
      Object.keys(payload)
        .filter((k) => payload[k] !== undefined)
        .forEach((k) => expect(allowedKeys).toContain(k));
    });

    it('blocks review until all three stages are entered (0 is valid, absent is not)', async () => {
      render(<LiceCountPage />);
      await flushAct(() => {
        fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'tank-1' } });
      });
      // Only two of three stages entered — the review CTA must stay disabled.
      await flushAct(() => {
        fireEvent.change(screen.getByLabelText(/Adult female lice/i), { target: { value: '0.1' } });
      });
      await flushAct(() => {
        fireEvent.change(screen.getByLabelText(/Mobile lice/i), { target: { value: '0.4' } });
      });
      const reviewBtn = screen.getByRole('button', { name: /Review Lice Count/i });
      expect((reviewBtn as HTMLButtonElement).disabled).toBe(true);
      expect(h.addToQueue).not.toHaveBeenCalled();
    });

    it('refuses to submit for a tank without a siteId (fail-closed, no wrong-site row)', async () => {
      render(<LiceCountPage />);
      await flushAct(() => {
        fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'tank-2' } });
      });
      await fillStages({ adult: '0.1', mobile: '0.4', attached: '0.2' });
      await flushAct(() => {
        fireEvent.click(screen.getByRole('button', { name: /Review Lice Count/i }));
      });
      // validate() fails on the missing site — we never reach the confirm screen.
      expect(screen.queryByRole('button', { name: /Confirm & Record/i })).toBeNull();
      expect(h.addToQueue).not.toHaveBeenCalled();
    });
  },
);
