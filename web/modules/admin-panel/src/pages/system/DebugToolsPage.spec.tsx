import '@testing-library/jest-dom/vitest';

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminCacheInvalidationReceiptSha256V1 } from '@aquaculture/shared-contracts';

import { databaseApi, debugApi } from '../../services/adminApi';
import DebugToolsPage from './DebugToolsPage';

vi.mock('../../services/adminApi', () => ({
  debugApi: {
    listCacheEntries: vi.fn(),
    getCacheStats: vi.fn(),
    invalidateCacheEntry: vi.fn(),
    invalidateCacheByPattern: vi.fn(),
  },
  databaseApi: {
    getConnectionStats: vi.fn(),
    executeExplorerQuery: vi.fn(),
  },
}));

const listing = {
  namespace: 'admin:',
  entries: [
    {
      key: 'report:abc',
      type: 'string',
      ttlSeconds: 120,
      sizeBytes: 128,
      idleSeconds: 42,
    },
  ],
  matchedCount: 1,
  truncated: false,
};

const stats = {
  namespace: 'admin:',
  keysInNamespace: 1,
  instance: {
    keyspaceHits: 8,
    keyspaceMisses: 2,
    hitRatePercent: 80,
    usedMemoryBytes: 2048,
    totalKeys: 15,
  },
};

const receiptEvidence = {
  schemaVersion: 'admin-cache-invalidation-receipt.v1',
  namespace: 'admin:',
  selector: { kind: 'KEY' as const, value: 'report:abc' },
  discoveredCount: 1,
  discoveredKeysDigest: 'discovered-sha256',
  deletedCount: 1,
  residualCount: 0,
  residualKeysDigest: 'residual-sha256',
  outcome: 'FULLY_INVALIDATED' as const,
};

const receipt = {
  ...receiptEvidence,
  receiptId: adminCacheInvalidationReceiptSha256V1(receiptEvidence),
};

describe('DebugToolsPage cache authority', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(debugApi.listCacheEntries).mockResolvedValue(listing);
    vi.mocked(debugApi.getCacheStats).mockResolvedValue(stats);
    vi.mocked(debugApi.invalidateCacheEntry).mockResolvedValue(receipt);
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders live namespace metadata without snapshot-only fields', async () => {
    render(<DebugToolsPage />);

    await waitFor(() => expect(screen.getByText('report:abc')).toBeInTheDocument());
    expect(debugApi.listCacheEntries).toHaveBeenCalledWith({ keyPattern: '*', limit: 200 });
    expect(screen.getByText('string')).toBeInTheDocument();
    expect(screen.getByText('2m 0s')).toBeInTheDocument();
    expect(screen.getByText('128.00 B')).toBeInTheDocument();
    expect(screen.getByText('42s')).toBeInTheDocument();
    expect(screen.queryByText('Hits')).not.toBeInTheDocument();
    expect(databaseApi.getConnectionStats).not.toHaveBeenCalled();
  });

  it('renders a rejected read as unavailable rather than an authoritative empty cache', async () => {
    vi.mocked(debugApi.listCacheEntries).mockRejectedValueOnce(new Error('Redis unavailable'));

    render(<DebugToolsPage />);

    await waitFor(() =>
      expect(screen.getByText('The cache could not be read')).toBeInTheDocument(),
    );
    expect(screen.queryByText('No keys match "*"')).not.toBeInTheDocument();
    expect(debugApi.getCacheStats).not.toHaveBeenCalled();
  });

  it('renders the content-addressed deletion receipt before accepting success', async () => {
    render(<DebugToolsPage />);
    await waitFor(() => expect(screen.getByText('report:abc')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Invalidate' }));

    await waitFor(() => expect(debugApi.invalidateCacheEntry).toHaveBeenCalledWith('report:abc'));
    expect(await screen.findByText(/Invalidation evidence: FULLY_INVALIDATED/)).toBeInTheDocument();
    expect(screen.getByText(receipt.receiptId)).toBeInTheDocument();
    expect(screen.getByText(/Discovered 1, deleted 1, residual 0/)).toBeInTheDocument();
  });

  it('rejects a receipt whose identity does not match its evidence', async () => {
    vi.mocked(debugApi.invalidateCacheEntry).mockResolvedValueOnce({
      ...receipt,
      receiptId: 'a'.repeat(64),
    });
    render(<DebugToolsPage />);
    await waitFor(() => expect(screen.getByText('report:abc')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Invalidate' }));

    expect(
      await screen.findByText('Cache invalidation receipt identity did not match its evidence'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Invalidation evidence:/)).not.toBeInTheDocument();
  });
});
