/**
 * EscapeIncidentPage contract tests (FARM-HIGH-214 / RPT-019).
 *
 * Locks the enqueued `recordEscapeIncident` payload to the backend
 * RecordEscapeIncidentInput SSoT: speciesId comes from the SELECTED TANK's
 * batch (the composition ledger), the immediate-varsling banner is always
 * visible, and a tank whose species is unknown fails closed instead of
 * filing a species-less incident.
 */

import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { EscapeIncidentPage } from '../EscapeIncidentPage';

const h = vi.hoisted(() => {
  const metrics = {
    batchId: 'batch-1',
    batchNumber: 'B-2026-001',
    speciesId: 'species-1',
    speciesName: 'Atlantic Salmon',
    pieces: 500,
    avgWeight: 3200,
    biomass: 1600,
    density: 1,
    capacityUsedPercent: 50,
    isOverCapacity: false,
    daysSinceStocking: 30,
  };
  const tank = {
    id: 'tank-1',
    name: 'Pen 1',
    code: 'P1',
    volume: 100,
    status: 'ACTIVE',
    currentBiomass: 1600,
    maxBiomass: 3000,
    siteId: 'site-1',
    batchMetrics: metrics,
  };
  const tankWithoutSpecies = {
    ...tank,
    id: 'tank-2',
    name: 'Pen 2',
    batchMetrics: { ...metrics, speciesId: null, speciesName: null },
  };
  return {
    addToQueue: vi.fn<
      (op: string, payload: Record<string, unknown>) => Promise<{ status: string; id: string }>
    >(() => Promise.resolve({ status: 'queued', id: 'op-888' })),
    tanks: [tank, tankWithoutSpecies],
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

vi.mock('lucide-react', () => {
  const Stub = (): ReactNode => <svg data-testid="icon" />;
  return {
    ArrowLeft: Stub,
    AlertCircle: Stub,
    Camera: Stub,
    ImageOff: Stub,
    Loader2: Stub,
    Minus: Stub,
    PhoneCall: Stub,
    Plus: Stub,
    ShieldAlert: Stub,
    TriangleAlert: Stub,
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

describe(
  'EscapeIncidentPage — RecordEscapeIncidentInput contract (FARM-HIGH-214)',
  { timeout: 20000 },
  () => {
    it('always shows the legally-immediate varsling banner', () => {
      render(<EscapeIncidentPage />);
      expect(screen.getByText(/legally IMMEDIATE/i)).toBeTruthy();
      expect(screen.getByText(/Notify your site manager NOW/i)).toBeTruthy();
    });

    it('enqueues speciesId from the tank batch plus site/tank/count/cause', async () => {
      render(<EscapeIncidentPage />);
      await flushAct(() => {
        fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'tank-1' } });
      });
      await flushAct(() => {
        fireEvent.click(screen.getByRole('button', { name: /Hole in Net/i }));
      });
      await flushAct(() => {
        fireEvent.click(screen.getByRole('button', { name: /Review ~1 Escaped Fish/i }));
      });
      await screen.findByRole('button', { name: /Confirm & Record/i });
      await flushAct(() => {
        fireEvent.click(screen.getByRole('button', { name: /Confirm & Record/i }));
      });
      await waitFor(() => expect(h.addToQueue).toHaveBeenCalledTimes(1));

      const [opName, payload] = h.addToQueue.mock.calls[0] ?? [];
      expect(opName).toBe('recordEscapeIncident');
      expect(payload).toMatchObject({
        siteId: 'site-1',
        tankId: 'tank-1',
        batchId: 'batch-1',
        speciesId: 'species-1',
        estimatedCount: 1,
        cause: 'HOLE_IN_NET',
        recoveryOngoing: false,
      });
      // avgWeightG defaults to the batch average when the operator enters none.
      expect(payload.avgWeightG).toBe(3200);
      expect(String(payload.detectedAt)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('fails closed when the batch species is unknown (no species-less incident)', async () => {
      render(<EscapeIncidentPage />);
      await flushAct(() => {
        fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'tank-2' } });
      });
      // canReview requires speciesId — the review CTA stays disabled.
      const reviewBtn = screen.getByRole('button', { name: /Review ~1 Escaped Fish/i });
      expect((reviewBtn as HTMLButtonElement).disabled).toBe(true);
      expect(h.addToQueue).not.toHaveBeenCalled();
    });
  },
);
