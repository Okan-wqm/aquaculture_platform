/**
 * useBuildSkewReload wires the build-skew check (FE-MEDIUM-380, PKG-42) to the three moments the
 * plan names: the tab regaining focus, a navigation, and a GraphQL validation failure reported by
 * shared-ui's client. The decision itself is buildSkew.spec.ts's; this spec proves the wiring.
 */
import { act, renderHook } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { BuildSkewDeps } from '../buildSkew';
import { useBuildSkewReload } from '../useBuildSkewReload';

const RUNNING = '1'.repeat(64);
const SERVED = '2'.repeat(64);

const h = vi.hoisted(() => ({
  fetchServedBuildId: vi.fn<() => Promise<string | null>>(),
  reload: vi.fn<() => void>(),
  validationListeners: new Set<() => void>(),
  unsubscribe: vi.fn<() => void>(),
}));

vi.mock('../buildSkew', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../buildSkew')>();
  const store = new Map<string, string>();
  return {
    ...actual,
    browserBuildSkewDeps: (): BuildSkewDeps => ({
      runningBuildId: RUNNING,
      fetchServedBuildId: h.fetchServedBuildId,
      reload: h.reload,
      now: () => Date.now(),
      storage: {
        getItem: (key) => store.get(key) ?? null,
        setItem: (key, value) => {
          store.set(key, value);
        },
        removeItem: (key) => {
          store.delete(key);
        },
      },
    }),
  };
});

vi.mock('@aquaculture/shared-ui', () => ({
  onGraphqlValidationFailure: (listener: () => void): (() => void) => {
    h.validationListeners.add(listener);
    return () => {
      h.validationListeners.delete(listener);
      h.unsubscribe();
    };
  },
}));

function wrapper({ children }: { children: ReactNode }): ReactElement {
  return <MemoryRouter initialEntries={['/sites']}>{children}</MemoryRouter>;
}

function useSkewWithNavigate(): ReturnType<typeof useNavigate> {
  useBuildSkewReload();
  return useNavigate();
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('useBuildSkewReload', () => {
  beforeEach(() => {
    h.fetchServedBuildId.mockReset();
    h.fetchServedBuildId.mockResolvedValue(SERVED);
    h.reload.mockReset();
    h.unsubscribe.mockReset();
    h.validationListeners.clear();
  });

  it('does not ask the server when the tab first renders', async () => {
    renderHook(() => useSkewWithNavigate(), { wrapper });
    await settle();
    expect(h.fetchServedBuildId).not.toHaveBeenCalled();
  });

  it('reloads on a navigation when the server serves another build', async () => {
    const { result } = renderHook(() => useSkewWithNavigate(), { wrapper });
    act(() => {
      void result.current('/hr');
    });
    await settle();
    expect(h.fetchServedBuildId).toHaveBeenCalledTimes(1);
    expect(h.reload).toHaveBeenCalledTimes(1);
  });

  it('checks when the window regains focus, without reloading', async () => {
    renderHook(() => useSkewWithNavigate(), { wrapper });
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await settle();
    expect(h.fetchServedBuildId).toHaveBeenCalledTimes(1);
    expect(h.reload).not.toHaveBeenCalled();
  });

  it('checks when the tab becomes visible again, not when it is hidden', async () => {
    let visibility: DocumentVisibilityState = 'hidden';
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibility,
    });
    renderHook(() => useSkewWithNavigate(), { wrapper });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await settle();
    expect(h.fetchServedBuildId).not.toHaveBeenCalled();

    visibility = 'visible';
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await settle();
    expect(h.fetchServedBuildId).toHaveBeenCalledTimes(1);
  });

  it('reloads when shared-ui reports a GraphQL validation failure and the build changed', async () => {
    renderHook(() => useSkewWithNavigate(), { wrapper });
    expect(h.validationListeners.size).toBe(1);
    act(() => {
      for (const listener of h.validationListeners) listener();
    });
    await settle();
    expect(h.reload).toHaveBeenCalledTimes(1);
  });

  it('stops listening when the shell unmounts', async () => {
    const { unmount } = renderHook(() => useSkewWithNavigate(), { wrapper });
    unmount();
    expect(h.unsubscribe).toHaveBeenCalledTimes(1);
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await settle();
    expect(h.fetchServedBuildId).not.toHaveBeenCalled();
  });
});
