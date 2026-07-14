/**
 * useIncidentMediaUpload tests — the upload-at-capture presign → PUT → key flow.
 *
 * Pins:
 *   - an allowed image requests the presign, PUTs to the RETURNED url, and
 *     resolves to the server storageKey,
 *   - a non-image file is rejected client-side before any network call,
 *   - a file over the 10 MB cap is rejected client-side.
 */
import { renderHook } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

const mockGraphqlRequest = vi.fn<(...args: unknown[]) => Promise<unknown>>();

vi.mock('@/services/authenticated-fetch', () => ({
  graphqlRequest: (...args: unknown[]) => mockGraphqlRequest(...args),
}));

import { useIncidentMediaUpload } from '../useIncidentMediaUpload';

/** Real jsdom File so the hook reads genuine .type/.name/.size. */
function fakeFile(type: string, sizeBytes = 8): File {
  return new File([new Uint8Array(sizeBytes)], `f.${type.split('/')[1] ?? 'bin'}`, { type });
}

describe('useIncidentMediaUpload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGraphqlRequest.mockResolvedValue({
      requestIncidentMediaUpload: {
        uploadUrl: 'http://minio/put/incident-abc',
        storageKey: 'incidents/key-1',
        expiresAt: '',
      },
    });
  });

  it('requests the presign then PUTs to the returned url and returns the storageKey', async () => {
    let putUrl = '';
    let putMethod = '';
    class FakeXHR {
      status = 200;
      upload = { addEventListener: vi.fn() };
      open = vi.fn((method: string, url: string): void => {
        putMethod = method;
        putUrl = url;
      });
      setRequestHeader = vi.fn();
      private listeners: Record<string, () => void> = {};
      addEventListener(event: string, cb: () => void): void {
        this.listeners[event] = cb;
      }
      send(): void {
        this.listeners['load']?.();
      }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXHR);
    try {
      const { result } = renderHook(() => useIncidentMediaUpload());
      const key = await result.current.uploadPhoto(fakeFile('image/jpeg'), 'WELFARE');

      expect(key).toBe('incidents/key-1');

      // Presign requested with the incident-scoped input.
      expect(mockGraphqlRequest).toHaveBeenCalledTimes(1);
      const [, variables] = mockGraphqlRequest.mock.calls[0];
      expect(variables).toMatchObject({
        input: { incidentType: 'WELFARE', mimeType: 'image/jpeg' },
      });

      // PUT went to the URL the presign returned.
      expect(putMethod).toBe('PUT');
      expect(putUrl).toBe('http://minio/put/incident-abc');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects a non-image file client-side (no network call)', async () => {
    const { result } = renderHook(() => useIncidentMediaUpload());
    await expect(
      result.current.uploadPhoto(fakeFile('application/pdf'), 'ESCAPE'),
    ).rejects.toThrow(/image/i);
    expect(mockGraphqlRequest).not.toHaveBeenCalled();
  });

  it('rejects a file over the 10 MB cap client-side (no network call)', async () => {
    const { result } = renderHook(() => useIncidentMediaUpload());
    const tooBig = fakeFile('image/jpeg', 11 * 1024 * 1024);
    await expect(result.current.uploadPhoto(tooBig, 'LICE')).rejects.toThrow(/10 MB/i);
    expect(mockGraphqlRequest).not.toHaveBeenCalled();
  });
});
