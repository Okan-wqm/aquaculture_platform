/**
 * StockMovementPage — queue-first two-phase UX (MOB-CRITICAL-021 class).
 *
 * The wizard used to submit directly online (falling back to the queue on a
 * transport error) and render an unconditional green success. It now enqueues
 * the generated RecordStockMovementInput (envelope stripped) online and offline
 * alike and shows the queued op's real sync status.
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
  useSearchParams: () => [new URLSearchParams('type=IN')],
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

// Virtualisation needs a measured viewport jsdom does not have; render rows plainly.
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

import { StockMovementPage } from '../StockMovementPage';

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

/** Consumables need neither lot/expiry nor notes, so the wizard is the short path. */
async function walkToConfirmAndSubmit(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: /Consumable/ }));
  next();
  fireEvent.click(await screen.findByRole('button', { name: /Bucket/ }));
  next();
  fireEvent.change(await screen.findByRole('spinbutton'), { target: { value: '3' } });
  next();
  fireEvent.click(await screen.findByRole('button', { name: /Main Store/ }));
  next();
  fireEvent.click(await screen.findByRole('button', { name: /^Confirm / }));
  await waitFor(() => expect(h.addToQueue).toHaveBeenCalledTimes(1));
}

describe('StockMovementPage — queue-first contract', () => {
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

  it('enqueues the generated RecordStockMovementInput and issues no direct mutation', async () => {
    render(createElement(StockMovementPage), { wrapper: wrapper(client) });
    await walkToConfirmAndSubmit();

    const [type, payload] = h.addToQueue.mock.calls[0] ?? [];
    expect(type).toBe('recordStockMovement');
    expect(payload).toMatchObject({
      movementType: 'IN',
      itemType: 'CONSUMABLE',
      itemId: 'item-1',
      quantity: 3,
      toLocationId: 'loc-1',
    });
    expect(payload).not.toHaveProperty('fromLocationId');
    expect(typeof (payload as Record<string, unknown>)['idempotencyKey']).toBe('string');
    for (const [document] of h.graphqlRequest.mock.calls) {
      expect(isMutationDocument(document)).toBe(false);
    }
    expect((await screen.findByTestId('queued-status-badge')).textContent).toBe('op-1');
    expect(screen.queryByText(/Movement Recorded/)).toBeNull();
  });

  it('takes the same path offline and shows the queued status, not "Queued for Sync" green', async () => {
    h.isOnline = false;
    render(createElement(StockMovementPage), { wrapper: wrapper(client) });
    await walkToConfirmAndSubmit();

    expect(h.addToQueue.mock.calls[0]?.[0]).toBe('recordStockMovement');
    expect((await screen.findByTestId('queued-status-badge')).textContent).toBe('op-1');
    expect(screen.queryByText(/Queued for Sync/)).toBeNull();
  });

  it('renders "Already recorded" when the queue deduped a double-tap', async () => {
    h.addToQueue.mockResolvedValue({ status: 'duplicate', id: 'op-0' });
    render(createElement(StockMovementPage), { wrapper: wrapper(client) });
    await walkToConfirmAndSubmit();

    expect(await screen.findByText(/Already recorded/)).toBeTruthy();
  });
});
