import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ENVIRONMENT_WINDOW_REFRESH_MS, useEnvironmentWindowAnchor } from '../useEnvironment';

describe('useEnvironmentWindowAnchor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-31T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('advances the UTC range anchor every five minutes and clears its timer', () => {
    const { result, unmount } = renderHook(() => useEnvironmentWindowAnchor());

    expect(result.current.toISOString()).toBe('2026-07-31T00:00:00.000Z');

    act(() => {
      vi.advanceTimersByTime(ENVIRONMENT_WINDOW_REFRESH_MS);
    });

    expect(result.current.toISOString()).toBe('2026-07-31T00:05:00.000Z');
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
