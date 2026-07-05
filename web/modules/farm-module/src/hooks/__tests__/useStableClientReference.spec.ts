/**
 * useStableClientReference spec (FARM-HIGH-126).
 *
 * Locks the idempotency-preserving contract: the reference is stable across
 * repeated reads (retries) and only rotates after reset() (post-success), so a
 * retried Mattilsynet submission reuses ONE klientReferanse instead of minting a
 * fresh UUID per click and creating duplicate regulator submissions.
 */
import { renderHook, act } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useStableClientReference } from '../useStableClientReference';

describe('useStableClientReference', () => {
  it('returns the SAME reference across repeated reads (retries)', () => {
    const { result } = renderHook(() => useStableClientReference());
    const first = result.current.get();
    expect(result.current.get()).toBe(first);
    expect(result.current.get()).toBe(first);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('mints a FRESH reference only after reset() (success rotation)', () => {
    const { result } = renderHook(() => useStableClientReference());
    const first = result.current.get();
    act(() => result.current.reset());
    const second = result.current.get();
    expect(second).not.toBe(first);
    expect(result.current.get()).toBe(second);
  });

  it('is stable across re-renders without reset', () => {
    const { result, rerender } = renderHook(() => useStableClientReference());
    const first = result.current.get();
    rerender();
    expect(result.current.get()).toBe(first);
  });
});
