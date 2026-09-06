/**
 * StockTransferPage — queue-first two-phase UX (MOB-CRITICAL-021 class).
 * See StockMovementPage.spec.tsx for the rationale; the transfer wizard has
 * five steps (item, from, to, quantity, confirm) and no traceability step.
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

vi.mock('@/components/BarcodeScanButton', () => ({
  BarcodeScanButton: () => null,
}));

vi.mock('@/components/VirtualList', () => ({
  VirtualList: <T,>({
    items,
    getKey,
    renderItem,
  }: {
    items: readonly T[];
    getKey: (item: T) => string;
    renderItem: (item: T, index: number) => ReactNode;
  }) =>
    createElement(
      'div',
      null,
      items.map((item, index) =>
        createElement('div', { key: getKey(item) }, renderItem(item, index)),
      ),
    ),
}));

import { StockTransferPage } from '../StockTransferPage';

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

function next(): void {
  fireEvent.click(screen.getByRole('button', { name: /Next/ }));
}

async function walkToConfirmAndSubmit(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: /Consumable/ }));
  fireEvent.click(await screen.findByRole('button', { name: /Bucket/ }));
  next();
  fireEvent.click(await screen.findByRole('button', { name: /Main Store/ }));
  next();
  fireEvent.click(await screen.findByRole('button', { name: /Dock/ }));
  next();
  fireEvent.change(await screen.findByRole('spinbutton'), { target: { value: '2' } });
  next();
  fireEvent.click(await screen.findByRole('button', { name: /Confirm Transfer/ }));
  await waitFor(() => expect(h.addToQueue).toHaveBeenCalledTimes(1));
}

describe('StockTransferPage — queue-first contract', () => {
  let client: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    h.isOnline = true;
    h.addToQueue.mockResolvedValue({ status: 'queued', id: 'op-1' });
    h.graphqlRequest.mockImplementation((_document: unknown, variables?: unknown) => {
      const vars = (variables ?? {}) as { itemType?: string };
      if (vars.itemType !== undefined) {
        return Promise.resolve({
          storageInventory: [
            { itemId: 'item-1', itemName: 'Bucket', unit: 'pcs', itemType: 'CONSUMABLE' },
          ],
        });
      }
      return Promise.resolve({
        storageLocations: {
          items: [
            { id: 'loc-1', name: 'Main Store', code: 'MS' },
            { id: 'loc-2', name: 'Dock', code: 'DK' },
          ],
        },
      });
    });
    client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
  });

  afterEach(() => {
    cleanup();
    client.clear();
  });

  it('enqueues the generated TransferStockInput and issues no direct mutation', async () => {
    render(createElement(StockTransferPage), { wrapper: wrapper(client) });
    await walkToConfirmAndSubmit();

    const [type, payload] = h.addToQueue.mock.calls[0] ?? [];
    expect(type).toBe('transferStock');
    expect(payload).toMatchObject({
      itemType: 'CONSUMABLE',
      itemId: 'item-1',
      fromLocationId: 'loc-1',
      toLocationId: 'loc-2',
      quantity: 2,
    });
    expect(typeof (payload as Record<string, unknown>)['idempotencyKey']).toBe('string');
    for (const [document] of h.graphqlRequest.mock.calls) {
      expect(isMutationDocument(document)).toBe(false);
    }
    expect((await screen.findByTestId('queued-status-badge')).textContent).toBe('op-1');
    expect(screen.queryByText(/Transfer Recorded/)).toBeNull();
  });

  it('takes the same path offline and shows the queued status', async () => {
    h.isOnline = false;
    render(createElement(StockTransferPage), { wrapper: wrapper(client) });
    await walkToConfirmAndSubmit();

    expect(h.addToQueue.mock.calls[0]?.[0]).toBe('transferStock');
    expect((await screen.findByTestId('queued-status-badge')).textContent).toBe('op-1');
    expect(screen.queryByText(/Queued for Sync/)).toBeNull();
  });

  it('renders "Already recorded" when the queue deduped a double-tap', async () => {
    h.addToQueue.mockResolvedValue({ status: 'duplicate', id: 'op-0' });
    render(createElement(StockTransferPage), { wrapper: wrapper(client) });
    await walkToConfirmAndSubmit();

    expect(await screen.findByText(/Already recorded/)).toBeTruthy();
  });
});
