/**
 * WaterQualityRecordPage — MOB-CRITICAL-020.
 *
 * The page used to send `parameters: {}` (a field the backend deleted) on every
 * submit and, offline, render an unconditional green "Measurement Recorded!".
 * It is now queue-first: the payload is the generated CreateWaterQualityInput
 * (envelope stripped), it goes through `addToQueue` online and offline alike,
 * and the success screen is the QueuedStatusBadge for the queued op — or the
 * "Already recorded" notice when the queue deduped a double-tap.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  isOnline: true,
  graphqlRequest: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  addToQueue: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  navigate: vi.fn(),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => h.navigate,
  useParams: () => ({ equipmentId: 'eq-1' }),
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ accessToken: 'token', tenantId: 'tenant-1', isAuthenticated: true }),
}));

vi.mock('@/hooks/useOfflineQueue', () => ({
  useOfflineQueue: () => ({ addToQueue: h.addToQueue, isOnline: h.isOnline }),
}));

vi.mock('@/services/authenticated-fetch', () => ({
  graphqlRequest: (...args: unknown[]) => h.graphqlRequest(...args),
}));

vi.mock('@/components/QueuedStatusBadge', () => ({
  QueuedStatusBadge: ({ operationId }: { operationId: string }) =>
    createElement('div', { 'data-testid': 'queued-status-badge' }, operationId),
}));

vi.mock('konsta/react', () => ({
  BlockTitle: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  List: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  ListInput: ({ children }: { children?: ReactNode }) => createElement('select', null, children),
}));

// The shared form is exercised by its own suite; here it is a fixed set of
// values so the assertion is about THIS page's payload, not the form's UI.
vi.mock('@aquaculture/farm-shared', () => ({
  DynamicMeasurementForm: ({
    onSubmit,
  }: {
    onSubmit: (
      values: Record<string, number | string | boolean>,
      notes: string,
      weatherConditions?: string,
    ) => void;
  }) =>
    createElement(
      'button',
      { onClick: () => onSubmit({ temperature: 12.5, ph: 7.2 }, 'clear water', 'sunny') },
      'Submit measurement',
    ),
}));

import { WaterQualityRecordPage } from '../WaterQualityRecordPage';

const PARAMETER = {
  parameterConfig: {
    id: 'p-1',
    code: 'temperature',
    name: 'Temperature',
    unit: '°C',
    dataType: 'NUMBER',
    precision: 1,
    group: 'physical',
    optimalMin: 8,
    optimalMax: 16,
    warningMin: 6,
    warningMax: 18,
    criticalMin: 4,
    criticalMax: 20,
    enumValues: null,
    displayOrder: 1,
    isRequired: true,
    chartColor: '#00f',
  },
};

function wrapper(client: QueryClient): ({ children }: { children: ReactNode }) => ReactNode {
  function Wrapper({ children }: { children: ReactNode }): ReactNode {
    return createElement(QueryClientProvider, { client }, children);
  }
  return Wrapper;
}

function isMutationDocument(document: unknown): boolean {
  const definitions = (document as { definitions?: Array<{ operation?: string }> }).definitions;
  return Array.isArray(definitions) && definitions.some((d) => d.operation === 'mutation');
}

async function submitOnce(): Promise<void> {
  const submit = await screen.findByRole('button', { name: /Submit measurement/ });
  fireEvent.click(submit);
  await waitFor(() => expect(h.addToQueue).toHaveBeenCalledTimes(1));
}

describe('WaterQualityRecordPage — queue-first contract (MOB-CRITICAL-020)', () => {
  let client: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    h.isOnline = true;
    h.addToQueue.mockResolvedValue({ status: 'queued', id: 'op-1' });
    h.graphqlRequest.mockImplementation((_document: unknown, variables?: unknown) => {
      const vars = (variables ?? {}) as { equipmentId?: string; filter?: unknown };
      if (vars.equipmentId !== undefined) {
        return Promise.resolve({ equipmentParameters: [PARAMETER] });
      }
      return Promise.resolve({ equipmentList: { items: [] } });
    });
    client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
  });

  afterEach(() => {
    cleanup();
    client.clear();
  });

  it('enqueues the generated input shape — no `parameters`, required equipmentId + dynamicParameters', async () => {
    render(createElement(WaterQualityRecordPage), { wrapper: wrapper(client) });
    await submitOnce();

    const [type, payload] = h.addToQueue.mock.calls[0] ?? [];
    expect(type).toBe('createWaterQuality');
    expect(payload).toMatchObject({
      equipmentId: 'eq-1',
      source: 'MANUAL',
      dynamicParameters: { temperature: 12.5, ph: 7.2 },
      notes: 'clear water',
      weatherConditions: 'sunny',
    });
    const record = payload as Record<string, unknown>;
    expect(record).not.toHaveProperty('parameters');
    expect(typeof record['measuredAt']).toBe('string');
    expect(typeof record['idempotencyKey']).toBe('string');
    // No direct mutation: the queue is the single write path.
    for (const [document] of h.graphqlRequest.mock.calls) {
      expect(isMutationDocument(document)).toBe(false);
    }
  });

  it('shows the queued op\'s real sync status online instead of a green "recorded"', async () => {
    render(createElement(WaterQualityRecordPage), { wrapper: wrapper(client) });
    await submitOnce();

    expect((await screen.findByTestId('queued-status-badge')).textContent).toBe('op-1');
    expect(screen.queryByText(/Measurement Recorded/)).toBeNull();
  });

  it('goes through the same queue offline and never claims the record synced', async () => {
    h.isOnline = false;
    render(createElement(WaterQualityRecordPage), { wrapper: wrapper(client) });
    await submitOnce();

    expect(h.addToQueue.mock.calls[0]?.[0]).toBe('createWaterQuality');
    expect((await screen.findByTestId('queued-status-badge')).textContent).toBe('op-1');
    expect(screen.queryByText(/Recorded!/)).toBeNull();
  });

  it('renders "Already recorded" when the queue deduped a double-tap (FE-HIGH-050)', async () => {
    h.addToQueue.mockResolvedValue({ status: 'duplicate', id: 'op-0' });
    render(createElement(WaterQualityRecordPage), { wrapper: wrapper(client) });
    await submitOnce();

    expect(await screen.findByText(/Already recorded/)).toBeTruthy();
    expect(screen.queryByTestId('queued-status-badge')).toBeNull();
  });

  it('surfaces a queue failure as an error banner, not a success screen', async () => {
    h.addToQueue.mockRejectedValue(new Error('Offline queue is full'));
    render(createElement(WaterQualityRecordPage), { wrapper: wrapper(client) });
    await submitOnce();

    expect(await screen.findByText(/Offline queue is full/)).toBeTruthy();
    expect(screen.queryByTestId('queued-status-badge')).toBeNull();
  });
});
