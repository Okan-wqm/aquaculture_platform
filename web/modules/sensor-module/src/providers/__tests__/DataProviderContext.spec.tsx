import React, { type ReactNode } from 'react';
import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const { lazyCalls } = vi.hoisted(() => ({ lazyCalls: vi.fn() }));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  const trackedLazy = (loader: Parameters<typeof actual.lazy>[0]) => {
    lazyCalls();
    return actual.lazy(loader);
  };

  return {
    ...actual,
    lazy: trackedLazy,
    default: {
      ...actual,
      lazy: trackedLazy,
    },
  };
});

vi.mock('../SimulationDataProvider', () => ({
  SimulationDataProviderInner: ({ children }: { children: ReactNode }) => (
    <div data-testid="simulation-provider">{children}</div>
  ),
}));

vi.mock('../LiveDeviceDataProvider', () => ({
  LiveDeviceDataProviderInner: ({ children }: { children: ReactNode }) => (
    <div data-testid="live-provider">{children}</div>
  ),
}));

vi.mock('../HybridDataProvider', () => ({
  HybridDataProviderInner: ({ children }: { children: ReactNode }) => (
    <div data-testid="hybrid-provider">{children}</div>
  ),
}));

import { DataProviderRoot } from '../DataProviderContext';

describe('DataProviderRoot', () => {
  it('creates one stable lazy component per provider and reuses it across transitions', async () => {
    expect(lazyCalls).toHaveBeenCalledTimes(3);

    const { rerender } = render(<DataProviderRoot type="simulation">content</DataProviderRoot>);
    expect(await screen.findByTestId('simulation-provider')).toBeTruthy();

    await act(async () => {
      React.startTransition(() => {
        rerender(<DataProviderRoot type="live">content</DataProviderRoot>);
      });
    });
    expect(await screen.findByTestId('live-provider')).toBeTruthy();

    await act(async () => {
      React.startTransition(() => {
        rerender(<DataProviderRoot type="hybrid">content</DataProviderRoot>);
      });
    });
    expect(await screen.findByTestId('hybrid-provider')).toBeTruthy();

    await act(async () => {
      React.startTransition(() => {
        rerender(<DataProviderRoot type="simulation">content</DataProviderRoot>);
      });
    });
    expect(await screen.findByTestId('simulation-provider')).toBeTruthy();
    expect(lazyCalls).toHaveBeenCalledTimes(3);
  });
});
