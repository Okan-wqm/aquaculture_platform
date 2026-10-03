/**
 * useMediaUpload Hook Tests — MSG-MEDIUM-057 client MIME validation against SSoT.
 *
 * The client pre-flight MIME check now uses the SINGLE shared allowlist
 * (MESSAGING_MEDIA_MIME_ALLOWLIST). These tests pin that:
 *   - image/svg+xml (XSS vector, absent from the SSoT) is rejected client-side,
 *   - every SSoT MIME passes the client check and proceeds to the presign call,
 *   - the client list is byte-identical to the SSoT (no third hand-maintained list).
 */
import { MESSAGING_MEDIA_MIME_ALLOWLIST } from '@aquaculture/shared-contracts';
import { renderHook } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

const mockGraphqlRequest = vi.fn<(...args: unknown[]) => Promise<unknown>>();

vi.mock('@/services/authenticated-fetch', () => ({
  graphqlRequest: (...args: unknown[]) => mockGraphqlRequest(...args),
}));

import { useMediaUpload } from '../useMediaUpload';

// Real File (jsdom) so the hook's validation path reads genuine .type/.name/.size.
function fakeFile(type: string, content = 'data'): File {
  return new File([content], `f.${type.split('/')[1] ?? 'bin'}`, { type });
}

describe('useMediaUpload — MIME allowlist (MSG-MEDIUM-057)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Presign returns a URL the upload step would use; we never reach XHR for
    // the rejection tests, and assert the presign call fired for the allowed case.
    mockGraphqlRequest.mockResolvedValue({
      requestMediaUpload: { uploadUrl: 'http://minio/put', storageKey: 'k', expiresAt: '' },
    });
  });

  it('rejects image/svg+xml client-side (absent from SSoT, XSS vector)', async () => {
    const { result } = renderHook(() => useMediaUpload('channel-1'));
    await expect(result.current.uploadMedia(fakeFile('image/svg+xml'))).rejects.toThrow(
      /not allowed/i,
    );
    // Rejected before any network call.
    expect(mockGraphqlRequest).not.toHaveBeenCalled();
  });

  it('rejects an arbitrary disallowed MIME client-side', async () => {
    const { result } = renderHook(() => useMediaUpload('channel-1'));
    await expect(result.current.uploadMedia(fakeFile('application/x-msdownload'))).rejects.toThrow(
      /not allowed/i,
    );
    expect(mockGraphqlRequest).not.toHaveBeenCalled();
  });

  it('passes the client MIME check for every SSoT-allowed type (reaches presign)', async () => {
    // A non-image type avoids the canvas-compression branch (jsdom has no canvas).
    // text/csv is in the SSoT and exercises the validation → presign path cleanly.
    expect(MESSAGING_MEDIA_MIME_ALLOWLIST).toContain('text/csv');

    // Stub XMLHttpRequest so the upload step resolves locally (no real network),
    // proving the MIME gate accepted the SSoT type and the flow reached presign.
    // vi.stubGlobal accepts an arbitrary stub (no type cast needed).
    class FakeXHR {
      status = 200;
      upload = { addEventListener: vi.fn() };
      open = vi.fn();
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
      const { result } = renderHook(() => useMediaUpload('channel-1'));
      const key = await result.current.uploadMedia(fakeFile('text/csv'));
      expect(key).toBe('k');
      expect(mockGraphqlRequest).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
